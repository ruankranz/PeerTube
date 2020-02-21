import { slice } from 'lodash'
import { ensureDir, readdir, remove } from 'fs-extra'
import { logger } from '@server/helpers/logger'
import { spawn } from 'child_process'
import { join } from 'path'

const NodeRtmpServer = require('node-media-server/node_rtmp_server')
const context = require('node-media-server/node_core_ctx')

const config = {
  rtmp: {
    port: 1935,
    chunk_size: 60000,
    gop_cache: true,
    ping: 60,
    ping_timeout: 30
  },
  transcoding: {
    ffmpeg: 'ffmpeg',
    output: '/tmp/super-live',
    resolutions: [ 1080, 480, 360 ]
  }
}

const transSessions = new Map()

context.nodeEvent.on('postPublish', function (id, streamPath, args) {
  logger.info('Post publish', { id, streamPath, args })

  const regRes = /\/(.*)\/(.*)/gi.exec(streamPath)
  const [ app, name ] = slice(regRes, 1)

  runMuxing(config, streamPath, app, name)
    .catch(err => logger.error('Cannot run muxing.', { err }))
})

context.nodeEvent.on('donePublish', function (id, streamPath, args) {
  const session = transSessions.get(id)

  if (session) {
    session.end()
  }
})

function runLiveServer () {
  const rtmpServer = new NodeRtmpServer(config)
  rtmpServer.run()
}

export {
  runLiveServer
}

// ############################################################################

const ffmpegResolutionsMapping = {
  1080: {
    videoBitrate: '4000k',
    width: '1920',
    acParam: [ '-b:a', '192k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=1920:-1', '-b:v', '5000k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '7500k' ]
  },

  720: {
    videoBitrate: '2500k',
    width: '1280',
    acParam: [ '-b:a', '128k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=1280:-1', '-b:v', '2800k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '4200k' ]
  },

  480: {
    videoBitrate: '1400k',
    width: '842',
    acParam: [ '-b:a', '128k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=854:-1', '-b:v', '1400k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '2100k' ]
  },

  360: {
    videoBitrate: '800k',
    width: '640',
    acParam: [ '-b:a', '96k', '-ar', 48000 ],
    vcParams: [ '-vf', 'scale=480:-1', '-b:v', '800k', '-preset', 'fast', '-profile:v', 'baseline', '-bufsize', '1200k' ]
  }
}

async function runMuxing (conf: typeof config, streamPath: string, streamApp, streamName: string) {
  const inPath = 'rtmp://127.0.0.1:' + conf.rtmp.port + streamPath

  const outPath = `${conf.transcoding.output}/${streamApp}/${streamName}`
  await ensureDir(outPath)

  let argv: string[] = [ '-y', '-fflags', 'nobuffer', '-i', inPath ]

  const varStreamMap: string[] = []

  const resolutions = conf.transcoding.resolutions

  let filterComplex = '[v:0]split=' + resolutions.length
  for (let i = 0; i < resolutions.length; i++) {
    filterComplex += `[vtemp00${i}]`
  }

  for (let i = 0; i < resolutions.length; i++) {
    const resolution = resolutions[i]
    const ffmpegOptions = ffmpegResolutionsMapping[resolution]

    filterComplex += `;[vtemp00${i}]scale=w=${ffmpegOptions.width}:h=${resolution}:force_original_aspect_ratio=decrease[vout00${i}]`
  }

  argv = argv.concat([
    '-filter_complex', `${filterComplex}`
  ])

  argv = argv.concat([
    '-r', '30',
    '-g', '60',
    '-keyint_min', '60',
    '-preset', 'superfast',
    '-pix_fmt', 'yuv420p'
  ])

  for (let i = 0; i < resolutions.length; i++) {
    const resolution = resolutions[i]
    const ffmpegOptions = ffmpegResolutionsMapping[resolution]

    argv = argv.concat([
      '-map', `[vout00${i}]`,
      `-c:v:${i}`, 'libx264',
      `-b:v:${i}`, ffmpegOptions.videoBitrate,
      '-map', 'a:0',
      `-c:a:${i}`, 'aac',
      `-b:a:${i}`, '128k'
    ])

    varStreamMap.push(`v:${i},a:${i}`)
  }

  argv = argv.concat([
    '-hls_time', '4',
    '-hls_list_size', '15',
    '-hls_flags', 'delete_segments',
    '-hls_segment_filename', join(outPath, '%v-%d.ts'),
    '-master_pl_name', 'master.m3u8',
    '-var_stream_map', varStreamMap.join(' ')
  ])

  argv = argv.concat([
    '-f', 'hls', join(outPath, '%v.m3u8')
  ])

  logger.info('Running live muxing.', { argv: argv.join(' ') })

  const ffmpegExec = spawn(conf.transcoding.ffmpeg, argv)

  ffmpegExec.on('error', (e) => {
    logger.error(e)
  })

  ffmpegExec.stdout.on('data', (data) => logger.debug(data))
  ffmpegExec.stderr.on('data', (data) => logger.debug(data))

  ffmpegExec.on('close', () => {
    logger.info('[Transmuxing end] ' + streamPath)

    readdir(outPath, function (err, files) {
      if (err) {
        logger.error('Cannot read directory %s.', outPath, { err })
        return
      }

      for (const filename of files) {
        if (
          filename.endsWith('.ts') ||
          filename.endsWith('.m3u8') ||
          filename.endsWith('.mpd') ||
          filename.endsWith('.m4s') ||
          filename.endsWith('.tmp')
        ) {
          const p = outPath + '/' + filename
          remove(p)
            .catch(err => logger.error('Cannot remove %s.', p, { err }))
        }
      }
    })
  })
}
