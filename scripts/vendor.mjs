import {copyFileSync} from 'node:fs';
copyFileSync(new URL('../node_modules/mqtt/dist/mqtt.esm.js',import.meta.url),new URL('../vendor/mqtt.esm.js',import.meta.url));
copyFileSync(new URL('../node_modules/mqtt/LICENSE.md',import.meta.url),new URL('../vendor/LICENSE.mqttjs.txt',import.meta.url));
