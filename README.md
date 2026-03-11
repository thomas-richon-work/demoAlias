# demoAlias

Application Node.js (API Express + interface web statique) deployable sur Azure App Service.

## Pre-requis

- Repo GitHub: `thomas-richon-work/demoAlias`
- Compte Azure

## 1) Variables d'environnement

Ne pas versionner `server/.env`.

Utiliser `server/.env.example` comme reference, puis configurer ces variables dans Azure App Service > `Environment variables`:

- `ORANGE_APP_ID`
- `ORANGE_CLIENT_ID`
- `ORANGE_CLIENT_SECRET`
- `SERVICE_ID`
- `C2C_APP_ID`
- `C2C_CLIENT_ID`
- `C2C_SECRET`
- `C2C_SERVICE_ID`
- `OPENAI_API_KEY`

Variables deja pre-remplies possibles (token URL, region, customer, etc.) selon ton contexte.

## 2) Deploiement Azure (Portal)

1. Azure Portal > `Create a resource` > `Web App`
2. Runtime stack: `Node 20 LTS`
3. Region: proche de tes utilisateurs
4. Deployment: connecter GitHub et choisir ce repo + branche `main`
5. Startup command: laisser vide (le projet utilise `npm start` dans `server/package.json`)
6. Dans `Configuration`:
   - Ajouter toutes les variables d'environnement
   - Ajouter `SCM_DO_BUILD_DURING_DEPLOYMENT=true`
7. Redemarrer l'app

## 3) Verification

- URL attendue: `https://<app-name>.azurewebsites.net`
- Endpoint sante: `GET /healthz`

## 4) Commandes locales

```bash
cd server
npm install
npm start
```

