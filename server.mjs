import {promisify} from 'node:util';
import http from 'node:http';
import fs from 'node:fs/promises';
import child_process from 'node:child_process';
import path from 'node:path';
import WebsocketLib from 'websocket';
const WebsocketServer = WebsocketLib.server;
const WebsocketRouter = WebsocketLib.router;
const spawn = child_process.spawn;

/**
 * Checks if an IP address belongs to a Local Area Network or Loopback.
 */
function isLocalAddress(ip) {
  if (!ip) return false;
  // Normalize IPv4-mapped IPv6 addresses (e.g., ::ffff:192.168.1.5 -> 192.168.1.5)
  const normalized = ip.replace(/^::ffff:/, '');

  if (normalized === '127.0.0.1' || normalized === '::1') return true;

  const parts = normalized.split('.').map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) return false;

  return (
    parts[0] === 10 || // 10.0.0.0 - 10.255.255.255
    (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) || // 172.16.0.0 - 172.31.255.255
    (parts[0] === 192 && parts[1] === 168) // 192.168.0.0 - 192.168.255.255
  );
}

async function respondWithFile(res, filename, customDisplayName = null, cleanup = false) {
  try {
    const fd = await fs.open(filename, 'r');
    const fileStat = await fd.stat();
    const headers = {};
    headers['content-length'] = fileStat.size;

    const downloadName = customDisplayName || path.basename(filename);
    // Sanitize filename for Content-Disposition header
    const encodedName = encodeURIComponent(downloadName);

    if (filename.endsWith('.mp3')) {
      headers['content-type'] = 'audio/mpeg';
      headers['content-disposition'] = `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`;
      headers['access-control-expose-headers'] = 'content-disposition';
    } else if (filename.endsWith('.mp4')) {
      headers['content-type'] = 'video/mp4';
      headers['content-disposition'] = `attachment; filename="${encodedName}"; filename*=UTF-8''${encodedName}`;
      headers['access-control-expose-headers'] = 'content-disposition';
    } else if (filename.endsWith('.png')) {
      headers['content-type'] = 'image/png';
    } else if (filename.endsWith('.html')) {
      headers['content-type'] = 'text/html';
    }

    const readStream = fd.createReadStream();
    res.writeHead(200, headers);
    readStream.pipe(res);

    if (cleanup) {
      // Delete local files once the response finishes streaming or errors out
      const deleteFile = async () => {
        try {
          await fs.unlink(filename);
          log(`Cleaned up file: ${filename}`);
        } catch (e) {
          log(`Error cleaning up file ${filename}: ${e.message}`);
        }
      };

      res.on('finish', deleteFile);
      res.on('close', deleteFile);
    }
  } catch (err) {
    log(`Error serving file ${filename}: ${err.message}`);
    if (!res.headersSent) {
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('File not found');
    }
  }
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
  const header = authHeader || '';
  const token = header.split(/\s+/).pop() || '';
  const auth = Buffer.from(token, 'base64').toString();
  const parts = auth.split(/:/);
  const username = parts.shift();
  const password = parts.join(':');
  return {username, password};
}

/**
 * Gets the actual title/filename from yt-dlp before or after downloading.
 */
async function getMediaTitle(downloadUrl) {
  return new Promise((resolve) => {
    const proc = spawn('yt-dlp', ['--get-filename', '-o', '%(title)s', downloadUrl]);
    let title = '';
    proc.stdout.on('data', data => title += data.toString());
    proc.on('close', () => {
      const sanitized = title.trim().replace(/[/\\?%*:|"<>]/g, '_');
      resolve(sanitized || 'download');
    });
    proc.on('error', () => resolve('download'));
  });
}

async function handleDownload(req, res, url, websocket) {
  const downloadUrl = url.searchParams.get('url');
  const speed = parseFloat(url.searchParams.get('speed') || '1');
  const filetype = url.searchParams.get('filetype') || 'mp4';
  
  log('downloading url: ' + downloadUrl);

  // Get original video title for the client's file header
  const title = await getMediaTitle(downloadUrl);
  const clientFilename = `${title}.${filetype}`;

  const tempFilename = `temp_${Date.now()}.${filetype}`;
  const ytArgs = filetype === 'mp3'
    ? ['--force-overwrites', '-o', tempFilename, '-x', '--audio-format', filetype, downloadUrl]
    : ['--force-overwrites', '-o', tempFilename, '-f', filetype, downloadUrl];

  try {
    const ytProc = spawn('yt-dlp', ytArgs);
    ytProc.stdout.setEncoding('utf8');
    ytProc.stdout.on('data', data => websocket?.sendUTF(data.toString()));
    ytProc.stderr.setEncoding('utf8');
    ytProc.stderr.on('data', data => websocket?.sendUTF(data.toString()));
    
    await new Promise(resolve => ytProc.on('close', resolve));
  } catch (error) {
    console.error('proc error: ' + error);
  }

  let finalFilename = tempFilename;

  if (speed !== 1) {
    const sampleRate = 44100;
    const newSampleRate = Math.ceil(speed * sampleRate);
    const speedFilename = `temp_speed_${Date.now()}.${filetype}`;
    log('running ffmpeg');
    
    const ptsScale = 1 / speed;
    const ffArgs = filetype === 'mp3'
      ? ['-y', '-i', tempFilename, '-af', `asetrate=${newSampleRate},aresample=${sampleRate}`, speedFilename]
      : ['-y', '-i', tempFilename, '-vf', `setpts=${ptsScale}*PTS`, '-af', `asetrate=${newSampleRate},aresample=${sampleRate}`, speedFilename];
    
    const ffProc = spawn('ffmpeg', ffArgs);
    ffProc.stdout.setEncoding('utf8');
    ffProc.stdout.on('data', data => websocket?.sendUTF(data.toString()));
    ffProc.stderr.setEncoding('utf8');
    ffProc.stderr.on('data', data => websocket?.sendUTF(data.toString()));
    
    await new Promise(resolve => ffProc.on('close', resolve));

    // Delete intermediate temporary file
    try { await fs.unlink(tempFilename); } catch (e) {}
    finalFilename = speedFilename;
  }

  // Stream file with YouTube title and delete it after streaming finishes
  await respondWithFile(res, finalFilename, clientFilename, true);
}

/**
 * Handles updating yt-dlp via endpoint
 */
async function handleUpdateYtdlp(req, res, websocket) {
  log('Starting yt-dlp update...');
  try {
    const proc = spawn('yt-dlp', ['-U']);
    
    proc.stdout.setEncoding('utf8');
    proc.stdout.on('data', data => {
      const str = data.toString();
      log(str);
      websocket?.sendUTF(str);
    });

    proc.stderr.setEncoding('utf8');
    proc.stderr.on('data', data => {
      const str = data.toString();
      log(str);
      websocket?.sendUTF(str);
    });

    await new Promise(resolve => proc.on('close', resolve));
    
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('yt-dlp update completed.');
  } catch (err) {
    log('Update error: ' + err.toString());
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end('Failed to update yt-dlp: ' + err.toString());
  }
}

const server = http.createServer(async (req, res) => {
  log(`${req.method} ${req.url} from ${req.socket.remoteAddress}`);
  try {
    const clientIp = req.socket.remoteAddress;
    const isLan = isLocalAddress(clientIp);

    // 1. Bypass authentication if connecting from LAN
    if (!isLan) {
      const secret = await secretPromise;
      const {username, password} = getUsernameAndPassword(req.headers.authorization);
      log('External client auth attempt: username=' + username);

      if (username !== secret) {
        log('rejecting, bad password from ' + clientIp);
        res.writeHead(401, {
          'www-authenticate': 'Basic realm="Dev", charset="UTF-8"'
        });
        res.end('whats the password');
        return;
      }
    } else {
      log('LAN connection detected. Bypassing authentication.');
    }

    const websocketHeader = req.headers['x-websocket-id'];
    const websocket = websocketMap.get(String(websocketHeader));

    const url = new URL(`http://${process.env.HOST ?? 'localhost'}${req.url}`); 
    if (url.pathname === '/slowmedown') {
      await respondWithFile(res, 'index.html');
      return;
    } else if (url.pathname === '/icon.png') {
      await respondWithFile(res, 'icon.png');
      return;
    } else if (url.pathname === '/slowmedownload') {
      await handleDownload(req, res, url, websocket);
      return;
    } else if (url.pathname === '/update-ytdlp') {
      // 4. Endpoint to update yt-dlp
      await handleUpdateYtdlp(req, res, websocket);
      return;
    }
  } catch (e) {
    log('error: ' + e.toString());
    res.writeHead(500, {'content-type': 'text/plain'});
    res.end('error: ' + e.toString());
    return;
  }
  res.writeHead(200, {'content-type': 'text/plain'});
  res.end('wrong path');
});

const websocketServer = new WebsocketServer({
  httpServer: server,
  autoAcceptConnections: false
});

const websocketRouter = new WebsocketRouter();
websocketRouter.attachServer(websocketServer);

let nextWebsocketId = 1;

websocketRouter.mount('/slowmedownsocket', null, async request => {
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