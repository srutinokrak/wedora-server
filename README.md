# WedPlan server configuration

Copy `.env.example` to `.env` and provide the MongoDB credentials, Stripe test secret key, and client application URLs. Keep `STRIPE_SECRET_KEY` only in the server environment; do not prefix it with `NEXT_PUBLIC_` or expose it in browser code.

## Premium payment

Premium is a one-time $29 USD payment. The client sends the displayed amount to the server, and the server accepts only the configured $29 amount before creating Stripe Checkout with inline price data. No Stripe Product or Price ID is required. The Stripe publishable key is not needed for the hosted Checkout redirect.

After Checkout, the success page asks the server to retrieve the Checkout Session from Stripe. The server verifies the completed payment, amount, and vendor ownership before enabling Premium. A success URL alone never enables Premium. This setup uses direct server verification and does not add a webhook endpoint.
