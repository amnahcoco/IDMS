# GBB Physical Security IDMS — Temporary Backend

This version keeps the existing IDMS dashboard and replaces browser `localStorage` with a shared server-side data file.

## Default login

- Email: `physicalsecurity@gbb.com.ng`
- Password: `Password12`

Set `IDMS_EMAIL` and `IDMS_PASSWORD` as environment variables when deploying if you want to change them.

## Run locally

```bash
node server.js
```

Open `http://localhost:3000`.

## Temporary hosting on Render

Create a **Web Service** from this project/repository.

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Health check: `/health`

Render provides a public `onrender.com` URL for a web service. The current temporary backend stores records in `data/idms.json`. Render's default filesystem is ephemeral, so data can be lost when the service redeploys or restarts. This is acceptable for the temporary access test only.

For the real deployment, move the personnel, batches, and history data to PostgreSQL and keep authentication/database permissions server-side.
