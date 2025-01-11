import {promisify} from 'node:util';
import http from 'node:http';
import fs from 'node:fs/promises';
import child_process from 'node:child_process';
import WebsocketLib from 'websocket';
const WebsocketServer = WebsocketLib.server;
const WebsocketRouter = WebsocketLib.router;
const spawn = child_process.spawn;

async function respondWithFile(res, filename) {
  const fd = await fs.open(filename, 'r');
  const fileStat = await fd.stat(filename);
  const headers = {};
  headers['content-length'] = fileStat.size;
  if (filename.endsWith('.mp3')) {
    headers['content-type'] = 'audio/mpeg';
    headers['content-disposition'] = filename;
  } else if (filename.endsWith('.mp4')) {
    headers['content-type'] = 'video/mp4';
    headers['content-disposition'] = filename;
  } else if (filename.endsWith('.png')) {
    headers['content-type'] = 'image/png';
  } else if (filename.endsWith('.html')) {
    headers['content-type'] = 'text/html';
  }
  const readStream = fd.createReadStream();
  res.writeHead(200, headers);
  readStream.pipe(res);
}

const bufferedLogs = [];
let writingToLogFile = false;
async function flushToLogFile() {
  if (writingToLogFile) {
    console.error('flushToLogFile called while already flushing!');
    process.exit(1);
    return;
  }
  writingToLogFile = true;
  const logFile = await fs.open('server.log', 'a');
  while (bufferedLogs.length) {
    const string = bufferedLogs.shift();
    logFile.write(string + '\n');
  }
  await logFile.close();
  writingToLogFile = false;
}
function log(string) {
  console.log(string);
  bufferedLogs.push(string);
  if (!writingToLogFile) {
    flushToLogFile();
  }
}

const secretPromise = new Promise(async resolve => {
  const file = await fs.readFile('secret', {encoding: 'utf-8'});
  resolve(file.trim());
});

const websocketMap = new Map();

function getUsernameAndPassword(authHeader) {
  const header = authHeader || '';       // get the auth header
  const token = header.split(/\s+/).pop() || '';        // and the encoded auth token
  const auth = Buffer.from(token, 'base64').toString(); // convert from base64
  const parts = auth.split(/:/);                        // split on colon
  const username = parts.shift();                       // username is first
  const password = parts.join(':');                     // everything else is the password
  return {username, password};
}

async function handleDownload(req, res, url, websocket) {
  const downloadUrl = url.searchParams.get('url');
  const speed = url.searchParams.get('speed');
  const filetype = url.searchParams.get('filetype');
  log('downloading url: ' + downloadUrl);
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
  });
  ytProc.stderr.setEncoding('utf8');
  ytProc.stderr.on('data', data => {
    const str = data.toString();
    if (websocket) {
      websocket.sendUTF(str);
    }
  });
  await new Promise(resolve => {
    ytProc.on('close', function (code) {
      resolve();
    });
  });

  let filename = `asdf.${filetype}`;

  if (speed != 1) {
    // TODO don't guess sample rate
    const sampleRate = 44100;
    const newSampleRate = Math.ceil(speed*sampleRate);
    log('running ffmpeg');
    // TODO make these args also work if theres a video track
    const ptsScale = 1 / speed;
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
    });
    ffProc.stderr.setEncoding('utf8');
    ffProc.stderr.on('data', function (data) {
      const str = data.toString();
      if (websocket) {
        websocket.sendUTF(str);
      }
    });
    await new Promise(resolve => {
      ffProc.on('close', function (code) {
        resolve();
      });
    });
    filename = `asdf-speed.${filetype}`;
  }

  await respondWithFile(res, filename);
}

const server = http.createServer(async (req, res) => {
  log(`${req.method} ${req.url}`);
  try {
    const websocketHeader = req.headers['x-websocket-id'];
    const websocket = websocketMap.get(String(websocketHeader));
    log('websocketHeader: ' + websocketHeader + ', websocket: ' + websocket);

    const secret = await secretPromise;
    const {username, password} = getUsernameAndPassword(req.headers.authorization);
    log('username: ' + username + ', password: ' + password);

    if (username != secret) {
      log('rejecting, bad password');
      res.writeHead(401, {
        'www-authenticate': 'Basic realm="Dev", charset="UTF-8"'
      });
      res.end('whats the password');
      return;
    }

    const url = new URL(`http://${process.env.HOST ?? 'localhost'}${req.url}`); 
    if (url.pathname == '/slowmedown') {
      await respondWithFile(res, 'index.html');
      return;
    } else if (url.pathname == '/icon.png') {
      await respondWithFile(res, 'icon.png');
      return;
    } else if (url.pathname == '/slowmedownload') {
      await handleDownload(req, res, url, websocket);
      return;
    }
  } catch (e) {
    log('error: ' + e.toString());
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

websocketRouter.mount('/slowmedownsocket', null, async request => {
  // https://bugs.webkit.org/show_bug.cgi?id=80362
  /*const {username, password} = getUsernameAndPassword(request.httpRequest.headers.authorization);
  log('websocket username: ' + username + ', password: ' + password);
  if (username != await secretPromise) {
    log('websocket bad secret, rejecting');
    request.reject();
    return;
  }*/

  const websocket = request.accept();
  const websocketId = nextWebsocketId++;
  log('created websocket with id: ' + websocketId);
  websocketMap.set(String(websocketId), websocket);
  websocket.on('close', (reasonCode, description) => {
    log('closed websocket with id: ' + websocketId
      + ', reasonCode: ' + reasonCode
      + ', description: ' + description);
    websocketMap.delete(websocketId);
  });
  websocket.sendUTF(websocketId);
});

const port = process.env.PORT || 48880;
server.listen(port);
log('listening on port ' + port);
