import {promisify} from 'node:util';
import http from 'node:http';
import fs from 'node:fs/promises';
import child_process from 'node:child_process';
const exec = promisify(child_process.exec);

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
    } else if (url.pathname = '/slowmedownload') {
      const downloadUrl = url.searchParams.get('url');
      console.log('downloading url: ' + downloadUrl);
      console.log('running yt-dlp...');
      const { stdout, stderr } = await exec(
        `yt-dlp -o asdf -x --audio-format mp3 "${downloadUrl}"`);
      console.log('stdout:');
      console.log(stdout);
      console.log('stderr:');
      console.log(stderr);
      console.log('going to reply with asdf.mp3');
      res.writeHead(200, {
        'content-type': 'audio/mpeg',
        'content-disposition': 'filename=asdf.mp3'
      });
      const contents = await fs.readFile('asdf.mp3');
      res.end(contents);
    }
  } catch (e) {
    res.writeHead(500, {'content-type': 'text/plain'});
    res.end('error: ' + e.toString());
  }
});

// TODO add port command line argument
server.listen(48880);
