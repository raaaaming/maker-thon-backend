import { createClient } from '@supabase/supabase-js';

// Thin data layer over supabase-js. The server uses the secret key (bypasses RLS),
// so EVERY query that touches user data must filter by user_id in app code.
// where = [[column, op, value], ...] with op in eq|neq|gt|gte|lt|lte|is.
function applyWhere(query, where) {
  for (const [col, op, val] of where) query = query[op](col, val);
  return query;
}
function unwrap({ data, error }) {
  if (error) {
    // Keep only a bounded code; never surface provider messages/details.
    const safe = new Error('database error');
    safe.code = /^[A-Za-z0-9_]{1,20}$/.test(error.code || '') ? error.code : 'DB_ERROR';
    throw safe;
  }
  return data ?? [];
}

export function createSupabaseStore(config) {
  if (!config.supabaseUrl || !config.secretKey) throw new Error('SUPABASE_URL and SUPABASE_SECRET_KEY are required');
  const client = createClient(config.supabaseUrl, config.secretKey, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
  return {
    async select(table, { where = [], order, limit } = {}) {
      let q = applyWhere(client.from(table).select('*'), where);
      if (order) q = q.order(order[0], { ascending: order[1] !== 'desc' });
      if (limit) q = q.limit(limit);
      return unwrap(await q);
    },
    async insert(table, rows, { ignoreDuplicates = false } = {}) {
      const q = ignoreDuplicates
        ? client.from(table).upsert(rows, { ignoreDuplicates: true }).select()
        : client.from(table).insert(rows).select();
      return unwrap(await q);
    },
    async upsert(table, row, onConflict) {
      return unwrap(await client.from(table).upsert(row, { onConflict }).select());
    },
    async update(table, where, patch) {
      return unwrap(await applyWhere(client.from(table).update(patch), where).select());
    },
    async remove(table, where) {
      return unwrap(await applyWhere(client.from(table).delete(), where).select());
    },
    async deleteUser(id) {
      const { error } = await client.auth.admin.deleteUser(id);
      if (error) throw new Error('delete user failed');
    },
    async ping() {
      unwrap(await client.from('devices').select('id').limit(1));
    },
  };
}
