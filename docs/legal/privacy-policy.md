# Scope Studio — Privacy Policy

> **DRAFT for legal review — not legal advice.** Bracketed items need facts only the owner can supply.
> Written to match how Scope Studio works as of October 2026; update it whenever data handling changes.

**Last updated:** [date]  
**Who we are:** Scope Studio is made by [Fourier Studios, legal entity name and type], [address] ("we", "us"). Contact: [privacy email].

## The short version

- Scope Studio is local-first. Your map — the code, documents and notes you connect, and the index built from them — is stored on the machine running Scope Studio.
- Questions are answered by a model on your machine whenever it can. Some answers use a cloud model (Anthropic); when that happens, the question and the retrieved excerpts it needs are sent to Anthropic to produce the answer.
- **Sources you mark private are never sent to any cloud service.** A question that needs them is answered locally or not at all.
- We do not sell your data, and we do not use your content to train models.
- Payments are handled by Stripe as the merchant of record; we never see your card details.

## What we collect, and why

| Data | Where it lives | Why |
|---|---|---|
| Email address and a password hash | Our account service | To sign you in and contact you about your account |
| Plan and subscription status, and Stripe customer and subscription identifiers | Our account service | To apply the plan you pay for |
| Content you connect (repositories, files, notes) and the index built from it | The machine running Scope Studio | To answer your questions |
| Your questions, the answers, and usage measurements (which sources were used, tokens, cost, timing) | The machine running Scope Studio; [account service, if usage is synced for plan limits] | To answer follow-ups, enforce plan limits, and improve retrieval |
| A GitHub access token, when you connect GitHub | Your signed-in session | To read the repositories you choose and, when you approve an edit, open a pull request |

We do not take screenshots of your screen. Actions that open pages, apps or files on your computer run on your computer, through your operating system, only when you approve them or have turned on Display mode.

## When data leaves your machine

- **Cloud answers (Anthropic).** For an answer routed to the cloud, the question and the retrieved excerpts it needs are sent to Anthropic. On Key Pro this uses your own Anthropic key, under your agreement with Anthropic. On Student and Engineer it uses ours. Excerpts from sources marked private are never included. Anthropic's handling of this data is described in its commercial terms and privacy policy [link].
- **Web search (Key Pro).** When you turn on Web, your question is sent to Anthropic's web search tool, which searches the public web.
- **GitHub.** When you connect GitHub, we read the repositories you choose. When you approve a proposed edit, it is committed to a new branch and opened as a pull request in that repository.
- **Payments (Stripe and Link).** Checkout, billing, receipts and payment support are handled by Stripe and Link as the merchant of record. Stripe's privacy policy applies to that data [link].
- **Search engine (screen actions).** When you approve a web search action, the search terms go to the search engine that opens in your browser (DuckDuckGo by default).

## How long we keep it

- Account data: for as long as your account exists, then deleted within [30] days of a deletion request, except where we must keep billing records by law.
- Content and usage on your machine: until you delete it or uninstall Scope Studio.
- Data sent to Anthropic, GitHub or Stripe is kept under their policies.

## Your choices and rights

- Mark any project or source private to keep it off every cloud service.
- Use Free, or Auto with no key, to keep every answer local.
- Request a copy, correction or deletion of your account data at [privacy email]. Depending on where you live (for example under the GDPR or California law), you may have further rights, including to object or to complain to a regulator; we will honour them.

## Security

Passwords are stored only as salted hashes. Your Anthropic key on Key Pro is held in memory for your session and sent with each cloud request; it is never written to disk or stored by us. Billing webhooks are verified by signature.

## Children

Scope Studio is not directed to children under [13 / 16 in the EEA] and we do not knowingly collect their data.

## Changes

We will post changes here and, for material changes, notify you by email or in the app before they take effect.
