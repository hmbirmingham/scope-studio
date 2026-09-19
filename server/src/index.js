import loadEnv from './config/env.js';
import createApp from './app.js';

const env = loadEnv();
const app = createApp(env);
const port = process.env.PORT || 3001;

app.listen(port, () => {
  console.log(`Scope Studio server listening on port ${port}`);
});
