# phloWS: Phlo WebSocket server

Multi-host WebSocket server for the [Phlo](https://phlo.tech) framework. Handles `/websocket` upgrades and `/message` casts on one port, routing by `Host` header. Per event it spawns a one-shot PHP CLI call (`<app.php> websocket::<method>`).

phloWS is the realtime half of the Phlo server layer; one process serves every app on the machine. App-side usage (hooks, `wsCast()`, the client) is covered in the [WebSocket chapter of the guide](https://phlo.tech/guide/websocket).

## Usage
```js
require('./phloWS.js')(3001, '/usr/bin/php-zts', {
  'example.com': '/srv/example.com/www/app.php',
})
```
Arguments: `(port, phpBinary, hostMap, listen = '127.0.0.1', maxBody = 1MB)`; `hostMap` maps each `Host` to its `app.php`.

## Install
```sh
npm install   # dependency: ws
```

## Production

Keep the host map in a small config file so the server and its hosts are managed in one place:

```js
// config/websocket.js
require('../websocket/phloWS.js')(3001, '/usr/bin/php-zts', {
  'example.com': '/srv/example.com/www/app.php',
  'dev.example.com': '/srv/example.com/www/app.php',
})
```

Run it under a process manager, for example pm2:

```sh
pm2 start config/websocket.js --name websocket
pm2 save
```

Every host that casts or accepts WebSocket connections must be listed in the host map. After adding a host, restart the process (`pm2 restart websocket`).

## HTTP bridge

Phlo's `wsCast()` posts to the bridge on the same port:

```
POST /message
{"host": "example.com", "target": "all", "data": {"toast": "Hi"}}
```

Responses: `200 {"status":"ok","host":...,"sent":N}` where `sent` is the number of clients reached. A `400` means the host is not in the host map: register it and restart.

## WebSocket callbacks

Connection events call back into the app via one-shot PHP CLI: `<app.php> websocket::<method>`. The engine's `websocket` resource maps those calls onto plain app functions: implement `wsAuth`, `wsConnect`, `wsReceive` and `wsClose` to handle the events (each is optional; a missing function is a no-op).
