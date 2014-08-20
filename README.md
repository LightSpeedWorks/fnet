fnet
====

network port proxy over the file system.
use 'fnet' instead of 'net'.


Installation
------------

```bash
$ npm install fnet
```
[![npm][npm-fnet.png]][npm-fnet]


Usage
-----

```js
var net  = require('net');
var fnet = require('fnet');

fnet.setConfig({dir: '/tmp/proxy_wk'});

// for server
var server = fnet.createServer(...);
server.listen(...);

// for client
var socket = fnet.connect(...);
```

# etc

License
-------

  MIT

Git Repository
--------------

  LightSpeedWorks/[fnet](https://github.com/LightSpeedWorks/fnet#readme)

[npm-fnet]: https://nodei.co/npm/fnet
[npm-fnet.png]: https://nodei.co/npm/fnet.png
