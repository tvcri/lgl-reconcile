import { fetchAllConstituents, fetchAllGroups, searchConstituents } from './lgl.js';

// const constituents = await fetchAllConstituents();
// console.log(`Fetched ${constituents.length} constituents`);

// const groups = await fetchAllGroups();
// console.log(`Fetched ${groups.length} groups`);
// console.log(JSON.stringify(groups, null, 2));

const groupMembers = await searchConstituents({
  groups: '3282',
  expand: 'groups,street_addresses'
});
console.log(`\nFetched ${groupMembers.items_count} constituents from group 3282`);
console.log(JSON.stringify(groupMembers, null, 2));

// const constituentsByName = await searchConstituents({
//   // name: 'Smigielski',
//   groups: '3267',
//   expand: 'groups,street_addresses'

// });
// console.log(`\nFetched ${constituentsByName.items_count} constituents matching name "Smigielski"`);
// console.log(JSON.stringify(constituentsByName, null, 2));

