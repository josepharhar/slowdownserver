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
      console.log('downloading url: ' + downloadUrl);
      console.log('running yt-dlp...');
      let { stdout, stderr } = await exec(
        `yt-dlp -o asdf -x --audio-format mp3 "${downloadUrl}"`);
      console.log('stdout:');
      console.log(stdout);
      console.log('stderr:');
      console.log(stderr);

      let filename = 'asdf.mp3';

      console.log('speed: ' + speed);
      if (speed != 1) {
        // TODO don't guess sample rate
        const sampleRate = 44100;
        const newSampleRate = Math.ceil(speed*sampleRate);
        console.log('running ffmpeg');
        const ffProc = spawn('ffmpeg',
          ['ffmpeg', '-i', 'asdf.mp3', '-af', `asetrate=${newSampleRate},aresample=${sampleRate}`, 'asdf-speed.mp3']);
        ffProc.stdout.setEncoding('utf8');
        ffProc.stdout.on('data', function (data) {
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
        filename = 'asdf-speed.mp3';

        /*let { stdout, stderr } = await exec(ffCommand);
        console.log('stdout:');
        console.log(stdout);
        console.log('stderr:');
        console.log(stderr);*/
      }

      console.log('going to reply with ' + filename);
      const contents = await fs.readFile(filename);
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-disposition': 'filename=asdf.mp3'
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
