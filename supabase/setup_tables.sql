-- =============================================================================
--  SeaFlow ERP — 새 Supabase 프로젝트 테이블 생성 스크립트
--  사용: 새 프로젝트 Dashboard → SQL Editor → 아래 전체 붙여넣고 Run
--  앱이 비어있는 테이블에 자동으로 시드 데이터를 채웁니다.
--  컬럼명은 앱(JS) 객체 키와 1:1 매칭 — camelCase 유지 위해 따옴표 필수.
-- =============================================================================

-- ── 화물 (shipments) ────────────────────────────────────────────────────────
create table if not exists public.shipments (
  "id"                 text primary key,
  "type"               text,
  "mode"               text,
  "customer"           text,
  "shipperName"        text,
  "shipper"            text,
  "consignee"          text,
  "pol"                text,
  "pod"                text,
  "carrier"            text,
  "booking"            text,
  "vessel"             text,
  "docCls"             text,
  "cargoCls"           text,
  "pickupYard"         text,
  "inYard"             text,
  "ts"                 text,
  "destTerminal"       text,
  "bl"                 text,
  "container"          text,
  "weight"             numeric,
  "incoterms"          text,
  "commodity"          text,
  "qty"                text,
  "status"             text,
  "etd"                text,
  "eta"                text,
  "revenueUsd"         numeric,
  "revenue"            numeric,
  "costUsd"            numeric,
  "cost"               numeric,
  "exRate"             numeric,
  "revenue_legacy"     numeric,
  "paid"               boolean,
  "blReleased"         boolean,
  "workflowStep"       integer,
  "billingMonth"       text,
  "billed"             boolean,
  "invoiceFromCarrier" numeric,
  "confirmStatus"      text,
  "confirmedAt"        text,
  "staff"              text,
  "memo"               text,
  "history"            jsonb,
  "_changed"           boolean,
  "_changedAt"         text,
  "created_at"         timestamptz default now()
);

-- ── 거래처 (partners) ───────────────────────────────────────────────────────
create table if not exists public.partners (
  "id"         text primary key,
  "kind"       text,
  "name"       text,
  "bizno"      text,
  "manager"    text,
  "phone"      text,
  "email"      text,
  "addr"       text,
  "memo"       text,
  "created_at" timestamptz default now()
);

-- ── 견적 (quotes) ───────────────────────────────────────────────────────────
create table if not exists public.quotes (
  "id"              text primary key,
  "shipper"         text,
  "commodity"       text,
  "pol"             text,
  "pod"             text,
  "qty"             text,
  "etd"             text,
  "status"          text,            -- draft / sent / fixed
  "selectedCarrier" text,
  "carriers"        jsonb,           -- [{name, price}, ...]
  "created_at"      timestamptz default now()
);

-- ── 권한: anon 키로 읽기/쓰기 허용 (현재 앱 동작과 동일) ──────────────────────
-- ⚠️ 누구나 anon 키로 접근 가능. 운영 강화 시 정책을 좁히세요.
alter table public.shipments enable row level security;
alter table public.partners  enable row level security;
alter table public.quotes    enable row level security;

drop policy if exists "seaflow_all" on public.shipments;
drop policy if exists "seaflow_all" on public.partners;
drop policy if exists "seaflow_all" on public.quotes;
create policy "seaflow_all" on public.shipments for all using (true) with check (true);
create policy "seaflow_all" on public.partners  for all using (true) with check (true);
create policy "seaflow_all" on public.quotes    for all using (true) with check (true);

grant all on public.shipments to anon, authenticated;
grant all on public.partners  to anon, authenticated;
grant all on public.quotes    to anon, authenticated;
