# Domain Migration Plan

## Phase 1: Redirect to the New Address

- Keep `www.dropmmssgg.uk` active.
- Configure an automatic redirect from the old URL to the new URL.
- Do not show an acknowledgment page, checkbox, prompt, or confirmation button.
- Keep the normal website and services running on the new domain.

## Phase 2: Maintain the Redirect

- Use a permanent `301` redirect to the new URL.
- Keep the redirect active for several months.
- Update bookmarks, published links, analytics, and any allowed-domain settings.

## Phase 3: Disconnect the Old Website

When visitors are familiar with the new URL:

1. Remove `dropmmssgg.uk` and `www.dropmmssgg.uk` from Render's custom domains.
2. Remove the old `A` and `CNAME` records from Cloudflare DNS.
3. Confirm the new domain still loads over HTTPS and all forms work.
4. Keep ownership and automatic renewal of the old domain enabled.

Keeping the old domain registered prevents another person from acquiring it. It can
remain parked with no website, or retain the permanent redirect as a safer option.
