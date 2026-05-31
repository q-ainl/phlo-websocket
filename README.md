# phloWS, Phlo WebSocket server

Multi-host WebSocket server for the [Phlo](https://phlo.tech) framework. Handles `/websocket` upgrades and `/message` casts on one port, routing by `Host` header. Per event it spawns a one-shot PHP CLI call (`<app.php> websocket::<method>`).

## Usage
```js
require('./phloWS.js')(3001, '/usr/bin/php-zts', {
  'example.com': '/srv/example.com/www/app.php',
})
```
Arguments: `(port, phpBinary, hostMap)`, `hostMap` maps each `Host` to its `app.php`.

## Install
```sh
npm install   # dependency: ws
```
