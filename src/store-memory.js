// In-memory store with the same contract as store-supabase.js. Used by tests.
const cmp = {
  eq: (a, b) => a === b, neq: (a, b) => a !== b,
  gt: (a, b) => a > b, gte: (a, b) => a >= b, lt: (a, b) => a < b, lte: (a, b) => a <= b,
  is: (a, b) => (b === null ? a == null : a === b),
};
const keys = { devices: ['id'], device_members: ['device_id', 'user_id'], profiles: ['id'], toilet_sessions: ['id'], meals: ['id'], deleted_sessions: ['id'] };
const match = (row, where) => where.every(([c, op, v]) => cmp[op](row[c], v));

export function createMemoryStore() {
  const tables = { devices: [], device_members: [], profiles: [], toilet_sessions: [], meals: [], deleted_sessions: [] };
  const clone = r => structuredClone(r);
  const same = (table, a, b) => keys[table].every(k => a[k] === b[k]);
  return {
    tables,
    async select(table, { where = [], order, limit } = {}) {
      let rows = tables[table].filter(r => match(r, where)).map(clone);
      if (order) { const [c, d] = order; rows.sort((a, b) => (a[c] > b[c] ? 1 : a[c] < b[c] ? -1 : 0) * (d === 'desc' ? -1 : 1)); }
      return limit ? rows.slice(0, limit) : rows;
    },
    async insert(table, rows, { ignoreDuplicates = false } = {}) {
      const out = [];
      for (const row of [].concat(rows)) {
        if (tables[table].some(r => same(table, r, row))) {
          if (ignoreDuplicates) continue;
          const e = new Error('duplicate'); e.code = '23505'; throw e;
        }
        tables[table].push(clone(row)); out.push(clone(row));
      }
      return out;
    },
    async upsert(table, row) {
      const i = tables[table].findIndex(r => same(table, r, row));
      if (i >= 0) Object.assign(tables[table][i], clone(row)); else tables[table].push(clone(row));
      return [clone(row)];
    },
    async update(table, where, patch) {
      const hit = tables[table].filter(r => match(r, where));
      hit.forEach(r => Object.assign(r, clone(patch)));
      return hit.map(clone);
    },
    async remove(table, where) {
      const hit = tables[table].filter(r => match(r, where));
      tables[table] = tables[table].filter(r => !hit.includes(r));
      return hit.map(clone);
    },
    async deleteUser(id) {
      tables.profiles = tables.profiles.filter(r => r.id !== id);
      tables.device_members = tables.device_members.filter(r => r.user_id !== id);
      tables.toilet_sessions = tables.toilet_sessions.filter(r => r.user_id !== id);
      tables.meals = tables.meals.filter(r => r.user_id !== id);
    },
    async ping() {},
  };
}
