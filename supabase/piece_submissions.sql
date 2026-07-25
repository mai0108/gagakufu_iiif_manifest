-- =============================================================
-- 利用者による曲登録機能のセットアップ
--
-- 実行方法:
--   Supabaseダッシュボード → 左メニュー「SQL Editor」→
--   このファイルの内容を貼り付けて「Run」を押す
-- =============================================================

-- 登録・承認の権限を持つ人を管理するテーブル
-- 行の追加・変更はSupabaseダッシュボード（Table Editor）から手動で行う想定
-- （このテーブル自体へのINSERT/UPDATE/DELETEを許可するRLSポリシーは置かない）
create table if not exists public.contributors (
  user_id uuid primary key references auth.users (id) on delete cascade,
  role text not null default 'contributor' check (role in ('contributor', 'admin')),
  created_at timestamptz not null default now()
);

alter table public.contributors enable row level security;

create policy "select_own_contributor_row" on public.contributors
  for select using (auth.uid() = user_id);

-- 曲の登録申請テーブル
create table if not exists public.piece_submissions (
  id uuid primary key default gen_random_uuid(),
  submitted_by uuid not null references auth.users (id) on delete cascade,
  series_id text not null check (series_id in ('100270332', '100376839')),
  volume_manifest_url text not null,
  volume_label text,
  instrument text not null,
  mode text,
  piece_name text not null,
  compilation_year text,
  start_page text not null,
  end_page text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'exported')),
  review_note text,
  reviewed_by uuid references auth.users (id),
  reviewed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.piece_submissions enable row level security;

-- 登録権限を持つ人（contributorsに登録されている人）だけが自分の申請として登録できる
create policy "contributors_can_insert" on public.piece_submissions
  for insert with check (
    auth.uid() = submitted_by
    and exists (select 1 from public.contributors c where c.user_id = auth.uid())
  );

-- 自分の申請は自分で閲覧可能。管理者は全件閲覧可能
create policy "select_own_or_admin" on public.piece_submissions
  for select using (
    submitted_by = auth.uid()
    or exists (select 1 from public.contributors c where c.user_id = auth.uid() and c.role = 'admin')
  );

-- 承認・却下・書き出し済みフラグの更新は管理者のみ
create policy "admin_can_update" on public.piece_submissions
  for update using (
    exists (select 1 from public.contributors c where c.user_id = auth.uid() and c.role = 'admin')
  );

create policy "admin_can_delete" on public.piece_submissions
  for delete using (
    exists (select 1 from public.contributors c where c.user_id = auth.uid() and c.role = 'admin')
  );

-- 登録者を追加する例（自分のuser_idはSupabaseダッシュボードのAuthentication > Usersで確認できます）:
-- insert into public.contributors (user_id, role) values ('ここにUUID', 'contributor');
-- 管理者にする場合:
-- insert into public.contributors (user_id, role) values ('ここにUUID', 'admin');
