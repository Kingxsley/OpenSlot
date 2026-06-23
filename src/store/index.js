// Picks the storage backend. No code elsewhere needs to know which one runs.
//   - No MONGODB_URI  -> JSON file (zero setup, great for local dev)
//   - MONGODB_URI set -> MongoDB (production, scales to many businesses)
import { jsonStore } from './jsonStore.js';

let store = jsonStore;

if (process.env.MONGODB_URI) {
  const { mongoStore } = await import('./mongoStore.js');
  store = mongoStore;
  console.log('  Storage: MongoDB');
} else {
  console.log('  Storage: JSON file (set MONGODB_URI to use MongoDB)');
}

await store.init();
export default store;
