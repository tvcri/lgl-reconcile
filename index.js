import { fetchAllConstituents } from './lgl.js';

const constituents = await fetchAllConstituents();
console.log(`Fetched ${constituents.length} constituents`);