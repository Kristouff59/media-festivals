-- BACKSTAGE · journal OpenAI privé, sans nouvelle requête IA.
-- Installer APRÈS schema.sql et migration-radar.sql.
-- Aucun article, aucune préférence et aucun créneau de veille n'est modifié.
create table if not exists public.editorial_ai_logs (
  id bigint generated always as identity primary key,
  slot text not null,
  stage text not null check (stage in ('decouverte', 'redaction')),
  status text not null check (status in ('completed', 'error')),
  model text not null,
  request_text text not null,
  response_text text not null default '',
  error_detail text not null default '',
  openai_response_id text,
  input_tokens integer not null default 0 check (input_tokens >= 0),
  output_tokens integer not null default 0 check (output_tokens >= 0),
  reasoning_tokens integer not null default 0 check (reasoning_tokens >= 0),
  web_search_calls integer not null default 0 check (web_search_calls >= 0),
  duration_ms integer not null default 0 check (duration_ms >= 0),
  created_at timestamptz not null default now(),
  constraint editorial_ai_logs_request_limit check (char_length(request_text) <= 16000),
  constraint editorial_ai_logs_response_limit check (char_length(response_text) <= 16000),
  constraint editorial_ai_logs_error_limit check (char_length(error_detail) <= 600)
);
create index if not exists editorial_ai_logs_recent
  on public.editorial_ai_logs(created_at desc);
alter table public.editorial_ai_logs enable row level security;
revoke all on public.editorial_ai_logs from anon, authenticated;
grant select on public.editorial_ai_logs to authenticated;
drop policy if exists editorial_ai_logs_admin_read on public.editorial_ai_logs;
create policy editorial_ai_logs_admin_read on public.editorial_ai_logs
  for select to authenticated using (
    exists (select 1 from public.editorial_admins a
            where a.user_id = (select auth.uid()))
  );

-- Mécanisme de purge automatique : une insertion retire les entrées
-- de plus de 30 jours, uniquement depuis une écriture du moteur serveur.
create or replace function public.trim_editorial_ai_logs()
returns trigger language plpgsql security definer set search_path = ''
as $$
begin
  delete from public.editorial_ai_logs
  where created_at < now() - interval '30 days';
  return new;
end;
$$;
revoke all on function public.trim_editorial_ai_logs() from public, anon, authenticated;
drop trigger if exists editorial_ai_logs_retention on public.editorial_ai_logs;
create trigger editorial_ai_logs_retention
  before insert on public.editorial_ai_logs
  for each statement execute function public.trim_editorial_ai_logs();

notify pgrst, 'reload schema';
