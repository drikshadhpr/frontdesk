'use strict';
// Single time source so tests/demo seeding can travel in time.
let override = null;
module.exports = {
  now: () => (override ? new Date(override) : new Date()),
  set: (d) => { override = d ? new Date(d) : null; },
};
