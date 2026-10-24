const fs = require('node:fs');
const path = require('node:path');

const source = path.join(__dirname, '..', 'src', 'renderer');
const destination = path.join(__dirname, '..', 'dist', 'renderer');

fs.mkdirSync(destination, { recursive: true });
fs.copyFileSync(
  path.join(source, 'index.html'),
  path.join(destination, 'index.html'),
);
