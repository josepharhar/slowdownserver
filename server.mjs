import {promisify} from 'node:util';
import http from 'node:http';
import fs from 'node:fs/promises';
import child_process from 'node:child_process';
const exec = promisify(child_process.exec);
const spawn = child_process.spawn;

const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  try {
    const url = new URL(`http://${process.env.HOST ?? 'localhost'}${req.url}`); 
    if (url.pathname == '/slowmedown') {
      try {
        const contents = await fs.readFile('index.html');
        res.writeHead(200, {
          'content-type': 'text/html'
        });
        res.end(contents);
      } catch (e) {
        res.writeHead(500, {
          'content-type': 'text/plain'
        });
        res.end('error:\n' + e);
      }
    } else if (url.pathname == '/slowmedownload') {
      const downloadUrl = url.searchParams.get('url');
      const speed = url.searchParams.get('speed');
      const filetype = url.searchParams.get('filetype');
      console.log('downloading url: ' + downloadUrl);
      console.log('running yt-dlp...');
      const ytArgs = filetype == 'mp3'
        ? ['--force-overwrites', '-o', 'asdf', '-x', '--audio-format', filetype, downloadUrl]
        : ['--force-overwrites', '-o', `asdf.${filetype}`, '-f', filetype, downloadUrl];
      const ytProc = spawn('yt-dlp', ytArgs);
      ytProc.stdout.setEncoding('utf8');
      ytProc.stdout.on('data', function (data) {
        var str = data.toString()
        var lines = str.split(/(\r?\n)/g);
        console.log(lines.join(""));
      });
      await new Promise(resolve => {
        ytProc.on('close', function (code) {
          console.log('process exit code ' + code);
          resolve();
        });
      });

      let filename = `asdf.${filetype}`;

      console.log('speed: ' + speed);
      if (speed != 1) {
        // TODO don't guess sample rate
        const sampleRate = 44100;
        const newSampleRate = Math.ceil(speed*sampleRate);
        console.log('running ffmpeg');
        // TODO make these args also work if theres a video track
        const ptsScale = 1 / speed;
        console.log(ptsScale);
        const ffArgs = filetype == 'mp3'
          ? ['-y', '-i', filename, '-af', `asetrate=${newSampleRate},aresample=${sampleRate}`, `asdf-speed.${filetype}`]
          : ['-y', '-i', filename, '-vf', `setpts=${ptsScale}*PTS`, '-af', `asetrate=${newSampleRate},aresample=${sampleRate}`, `asdf-speed.${filetype}`];
        const ffProc = spawn('ffmpeg', ffArgs);
        ffProc.stdout.setEncoding('utf8');
        ffProc.stdout.on('data', function (data) {
          var str = data.toString()
          var lines = str.split(/(\r?\n)/g);
          console.log(lines.join(""));
        });
        ffProc.stderr.setEncoding('utf8');
        ffProc.stderr.on('data', function (data) {
          var str = data.toString()
          var lines = str.split(/(\r?\n)/g);
          console.log(lines.join(""));
        });
        await new Promise(resolve => {
          ffProc.on('close', function (code) {
            console.log('process exit code ' + code);
            resolve();
          });
        });
        filename = `asdf-speed.${filetype}`;
      }

      console.log('going to reply with ' + filename);
      const contents = await fs.readFile(filename);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-disposition': `filename=${filename}`
      });
      res.end(contents);
    }
  } catch (e) {
    res.writeHead(500, {'content-type': 'text/plain'});
    res.end('error: ' + e.toString());
  }
});

// TODO add port command line argument
server.listen(48880);
