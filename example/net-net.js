'use strict';
var net  = require('net');
var HTTP_PORT  = process.argv[2] || 8080;  // service port
var PROXY_HOST = process.argv[3] || null;  // proxy server host
var PROXY_PORT = process.argv[4] || 80;    // proxy server port

if (!PROXY_HOST) return console.log('proxy server not found');

var server = net.createServer(function onCliConn(cliSoc) {
  console.log('%s cliSoc: connected!', new Date().toLocaleTimeString());
  var svrSoc = net.connect(PROXY_PORT, PROXY_HOST, function onSvrConn(err) {
    if (err)
      console.log('%s svrCon: %s', new Date().toLocaleTimeString(), err);

    svrSoc.pipe(cliSoc);
    cliSoc.pipe(svrSoc);
  });
  cliSoc.on('error', function (err) {
    console.log('%s cliSoc: %s', new Date().toLocaleTimeString(), err);
    svrSoc.destroy();
  });
  svrSoc.on('error', function (err) {
    console.log('%s svrSoc: %s', new Date().toLocaleTimeString(), err);
    cliSoc.destroy();
  });
}).listen(HTTP_PORT, function () {
  process.on('uncaughtException', function (err) {
    var msg1 = /\n    at exports._errnoException \(util.js:\d*:\d*\)\n    at TCP.onread \(net.js:\d*:\d*\)/;
    console.log('uncExc %s', err.stack.replace(msg1, ''));
  });
});

server.on('error', function onSvrErr(err) {
  console.log('%s svrErr: %s', new Date().toLocaleTimeString(), err);
}); // server.on error

console.log('port forwarder started on port ' + HTTP_PORT +
            ' -> ' + PROXY_HOST + ':' + PROXY_PORT);
