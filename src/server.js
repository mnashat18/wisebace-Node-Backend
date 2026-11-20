import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import compression from 'compression';
import knexFactory from 'knex';
import { createAuthenticate } from './middleware/authenticate.js';
import { createWorkspaceRouter } from './routes/workspaces.js';

const app = express();
const port = Number(process.env.PORT || 3000);
const origins = (process.env.CORS_ORIGINS || '').split(',').map(v => v.trim()).filter(Boolean);
app.disable('x-powered-by');
app.use(helmet());
app.use(compression());
app.use(cors({
  origin(origin, callback) {
    if (!origin || origins.length === 0 || origins.includes(origin)) return callback(null,true);
    return callback(new Error('Origin is not allowed by CORS'));
  },
  credentials:true
}));
app.use(express.json({limit:'1mb',strict:true}));

let db;
if (process.env.DATABASE_URL) {
  db = knexFactory({client:'pg',connection:process.env.DATABASE_URL,pool:{min:0,max:10}});
  app.locals.db = db;
}
const requireDatabase = (_req,res,next) => db
  ? next()
  : res.status(503).json({error:{code:'DATABASE_NOT_CONFIGURED',message:'Database is not configured.'}});
const authenticate = db ? createAuthenticate({db}) : (_req,res) =>
  res.status(503).json({error:{code:'DATABASE_NOT_CONFIGURED',message:'Database is not configured.'}});

app.get('/health',(_req,res) => res.status(200).json({status:'ok',service:'wisepace-node-backend'}));
app.get('/ready',async (_req,res) => {
  if (!db) return res.status(503).json({status:'not_ready',reason:'DATABASE_URL is not configured'});
  try { await db.raw('select 1'); return res.status(200).json({status:'ready',database:'connected'}); }
  catch { return res.status(503).json({status:'not_ready',database:'unavailable'}); }
});
app.use('/workspaces',requireDatabase,createWorkspaceRouter({db,env:process.env,authenticate}));
app.use((_req,res) => res.status(501).json({
  error:{code:'NOT_IMPLEMENTED',message:'This endpoint has not been migrated yet.'}
}));
app.use((err,_req,res,_next) => {
  const forbidden = err.message === 'Origin is not allowed by CORS';
  res.status(forbidden ? 403 : 500).json({error:{
    code:forbidden ? 'FORBIDDEN_ORIGIN' : 'INTERNAL_ERROR',
    message:forbidden ? 'Origin is not allowed.' : 'An unexpected error occurred.'
  }});
});
const server = app.listen(port,() => process.stdout.write(`WisePace API listening on :${port}\\n`));
for (const signal of ['SIGINT','SIGTERM']) {
  process.on(signal,() => server.close(async () => { if(db) await db.destroy(); process.exit(0); }));
}
