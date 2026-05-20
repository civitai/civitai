# Security Policy

Thanks for taking the time to help keep Civitai and our community safe.

## Reporting a Vulnerability

Email **security@civitai.com** with the details of any suspected vulnerability. Please do not file a public GitHub issue, open a pull request that demonstrates the issue, or disclose the finding in our Discord, on social media, or to support@civitai.com.

When you write, include as much of the following as you can:

- A clear description of the issue and the impact you believe it could have
- Step-by-step reproduction (URLs, payloads, screenshots, HAR files, etc.)
- The affected component, subdomain, or endpoint
- Any accounts, IDs, or artifacts created during your testing so we can clean them up
- How you'd like to be credited if we publish an acknowledgment

If you'd prefer to use encryption, mention that in your first message and we'll arrange a key exchange.

## Our Commitments

- We acknowledge new reports within **3 business days**
- We give a substantive update (triage outcome, planned fix window, or follow-up questions) within **14 days**
- We coordinate disclosure timing with you for anything that warrants public write-up
- We will not pursue legal action against researchers who follow this policy in good faith

## Scope

In scope:

- `civitai.com` and its subdomains (e.g. `image.civitai.com`, `orchestration.civitai.com`, `search.civitai.com`)
- The Civitai API and tRPC endpoints under `civitai.com/api/*`
- The Civitai mobile and orchestration services
- This repository (`github.com/civitai/civitai`) and the code it ships

Out of scope:

- Third-party services we integrate with (report those directly to the vendor)
- Social-engineering, phishing, or physical attacks against staff or infrastructure
- Volumetric denial-of-service testing
- Findings that require a compromised end-user device or stolen credentials
- Automated scanner output without a demonstrated impact
- Missing security headers, cookie attributes, or SPF/DMARC tweaks unless tied to a concrete exploit
- Source-map exposure on the public Next.js bundle (we currently treat this as acceptable)
- Verbose framework error messages without sensitive data leakage

## Testing Guidelines

We ask researchers to:

- Use a dedicated test account where possible and avoid touching real user data
- Stop as soon as you have a proof-of-concept; do not exfiltrate data, pivot, or persist access
- Avoid destructive actions (no mass deletion, no resource exhaustion, no spam to other users)
- Tell us about any test artifacts (workflows, uploads, accounts) so we can purge them
- Hold off on public disclosure until we have shipped a fix or agreed on a timeline with you

## Acknowledgments

We're grateful to the following researchers for responsibly disclosing issues that helped harden Civitai:

- **Ihor Herasymovych** ([@mgorunuch](https://github.com/mgorunuch)) - 2026-05 - coordinated disclosure of a connected set of findings across the public site, orchestration, and DNS surface, including a subdomain takeover, a cross-site request forgery on tRPC mutations, and an unauthenticated MCP tool-dispatch path

If you've reported an issue and would like to be added (or removed), let us know in your follow-up email.
