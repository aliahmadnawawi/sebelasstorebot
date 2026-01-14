create extension if not exists pgcrypto;

do $$ begin
  if not exists (select 1 from pg_type where typname = 'product_type') then
    create type product_type as enum ('FILE','LICENSE');
  end if;
  if not exists (select 1 from pg_type where typname = 'order_status') then
    create type order_status as enum ('PENDING_PAYMENT','PAID','EXPIRED','CANCELLED');
  end if;
end $$;

create table if not exists users (
  id bigserial primary key,
  telegram_id bigint unique not null,
  balance bigint not null default 0,
  created_at timestamptz not null default now()
);

create table if not exists products (
  id bigserial primary key,
  name text not null,
  description text,
  price bigint not null,
  type product_type not null,
  file_path text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);

create table if not exists license_stock (
  id bigserial primary key,
  product_id bigint not null references products(id) on delete cascade,
  code text not null,
  is_used boolean not null default false,
  used_at timestamptz,
  used_by_order_id text,
  created_at timestamptz not null default now()
);

create table if not exists orders (
  id bigserial primary key,
  order_code text unique not null,         -- SSB-YYYYMMDD-XXXXXX
  user_id bigint not null references users(id),
  product_id bigint not null references products(id),
  amount bigint not null,
  pay_method text not null,                -- QRIS | BALANCE
  status order_status not null,
  created_at timestamptz not null default now(),
  internal_expired_at timestamptz,
  paid_at timestamptz,
  delivered_at timestamptz
);

create table if not exists payments (
  id bigserial primary key,
  order_id bigint not null references orders(id) on delete cascade,
  provider text not null default 'pakasir',
  provider_order_id text not null,          -- sama dgn order_code
  amount bigint not null,
  status text not null,                     -- PENDING/COMPLETED/EXPIRED
  pakasir_expired_at timestamptz,
  raw jsonb,
  created_at timestamptz not null default now(),
  completed_at timestamptz
);

create index if not exists idx_products_active on products(is_active);
create index if not exists idx_orders_user on orders(user_id);
create index if not exists idx_stock_unused on license_stock(product_id, is_used);
