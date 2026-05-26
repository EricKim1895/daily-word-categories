create extension if not exists pg_net with schema extensions;
create extension if not exists pg_cron with schema extensions;
create schema if not exists vault;
create extension if not exists supabase_vault with schema vault;

-- Required Vault secrets before this job can invoke the Edge Function:
-- select vault.create_secret('https://wqxxwrudgetmzflfjejd.supabase.co', 'project_url');
-- select vault.create_secret('<same value as Edge Function CRON_SECRET>', 'daily_word_categories_cron_secret');

do $$
begin
  if exists (
    select 1
    from cron.job
    where jobname = 'generate-daily-word-categories-0600-shanghai'
  ) then
    perform cron.unschedule('generate-daily-word-categories-0600-shanghai');
  end if;
end;
$$;

select cron.schedule(
  'generate-daily-word-categories-0600-shanghai',
  '0 22 * * *',
  $$
  select net.http_post(
    url := (
      select decrypted_secret
      from vault.decrypted_secrets
      where name = 'project_url'
      limit 1
    ) || '/functions/v1/generate-daily-puzzle',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', (
        select decrypted_secret
        from vault.decrypted_secrets
        where name = 'daily_word_categories_cron_secret'
        limit 1
      )
    ),
    body := jsonb_build_object(
      'date', (now() at time zone 'Asia/Shanghai')::date
    )
  ) as request_id;
  $$
);
