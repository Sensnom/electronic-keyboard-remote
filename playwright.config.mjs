import {defineConfig} from '@playwright/test';

export default defineConfig({
 testDir:'./tests/browser',
 use:{baseURL:'http://127.0.0.1:41873',viewport:{width:390,height:844}},
 webServer:{command:'python3 -m http.server 41873 --bind 127.0.0.1',url:'http://127.0.0.1:41873',reuseExistingServer:false},
});
