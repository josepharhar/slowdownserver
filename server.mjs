import http from 'node:http';
import fs from 'node:fs/promises';

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
    }
  } catch (e) {
    res.writeHead(500, {'content-type': 'text/plain'});
    res.end('error: ' + e.toString());
  }
});

// TODO add port command line argument
server.listen(48880);
