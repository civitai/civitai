import redbird from 'redbird';

const greenProxy = redbird({ port: 3001, xfwd: false, bunyan: false });
greenProxy.register('localhost', 'http://localhost:3000');
console.log('Green proxy:', 'http://localhost:3001');

const redProxy = redbird({ port: 3002, xfwd: false, bunyan: false });
redProxy.register('localhost', 'http://localhost:3000');
console.log('Red proxy:', 'http://localhost:3002');
