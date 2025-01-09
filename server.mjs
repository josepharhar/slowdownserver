import {promisify} from 'node:util';
import http from 'node:http';
import fs from 'node:fs/promises';
import child_process from 'node:child_process';
import WebsocketLib from 'websocket';
const WebsocketServer = WebsocketLib.server;
const WebsocketRouter = WebsocketLib.router;
const spawn = child_process.spawn;

// TODO add log file
// TODO add websocket for frontend to see subprocess output
const websocketMap = new Map();

const server = http.createServer(async (req, res) => {
  console.log(`${req.method} ${req.url}`);
  try {
    const websocketHeader = req.headers['x-websocket-id'];
    const websocket = websocketMap.get(String(websocketHeader));
    console.log('websocketHeader: ' + websocketHeader + ', websocket: ' + websocket);

    const header = req.headers.authorization || '';       // get the auth header
    const token = header.split(/\s+/).pop() || '';        // and the encoded auth token
    const auth = Buffer.from(token, 'base64').toString(); // convert from base64
    const parts = auth.split(/:/);                        // split on colon
    const username = parts.shift();                       // username is first
    const password = parts.join(':');                     // everything else is the password

    const secret = (await fs.readFile('secret', {encoding: 'utf-8'})).trim();
    console.log('username: ' + username);
    console.log('password: ' + password);
    console.log('secret: ' + secret);

    if (username != secret) {
      console.log('rejecting, bad password');
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="Dev", charset="UTF-8"'
      });
      res.end('whats the password');
      return;
    }

    const url = new URL(`http://${process.env.HOST ?? 'localhost'}${req.url}`); 
    if (url.pathname == '/slowmedown') {
      try {
        const contents = await fs.readFile('index.html');
        res.writeHead(200, {
          'content-type': 'text/html'
        });
        res.end(contents);
        return;
      } catch (e) {
        res.writeHead(500, {
          'content-type': 'text/plain'
        });
        res.end('error:\n' + e);
        return;
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
      ytProc.stdout.on('data', data => {
        const str = data.toString();
        if (websocket) {
          websocket.sendUTF(str);
        }
        const lines = str.split(/(\r?\n)/g);
        console.log(lines.join(""));
      });
      ytProc.stderr.setEncoding('utf8');
      ytProc.stderr.on('data', data => {
        const str = data.toString();
        if (websocket) {
          websocket.sendUTF(str);
        }
        const lines = str.split(/(\r?\n)/g);
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
          const str = data.toString();
          if (websocket) {
            websocket.sendUTF(str);
          }
          const lines = str.split(/(\r?\n)/g);
          console.log(lines.join(""));
        });
        ffProc.stderr.setEncoding('utf8');
        ffProc.stderr.on('data', function (data) {
          const str = data.toString();
          if (websocket) {
            websocket.sendUTF(str);
          }
          const lines = str.split(/(\r?\n)/g);
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
      return;
    }
  } catch (e) {
    console.log('error: ' + e.toString());
    res.writeHead(500, {'content-type': 'text/plain'});
    res.end('error: ' + e.toString());
    return;
  }
});

const websocketServer = new WebsocketServer({
  httpServer: server,
  autoAcceptConnections: false
});

const websocketRouter = new WebsocketRouter();
websocketRouter.attachServer(websocketServer);

let nextWebsocketId = 1;

websocketRouter.mount('/slowmedownsocket', null, request => {
  // TODO check password and request.reject() if its not good?
  const websocket = request.accept();
  const websocketId = nextWebsocketId++;
  console.log('created websocket with id: ' + websocketId);
  websocketMap.set(String(websocketId), websocket);
  websocket.on('close', (reasonCode, description) => {
    console.log('closed websocket with id: ' + websocketId
      + ', reasonCode: ' + reasonCode
      + ', description: ' + description);
    websocketMap.delete(websocketId);
  });
  websocket.sendUTF(websocketId);
});

server.listen(process.env.PORT || 48880);
