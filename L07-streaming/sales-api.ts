import type { Express, Request, Response } from "express";
import { readAudit } from "./audit.ts";
import { answerSalesQuery, dataHealth, httpStatus } from "./sales-query.ts";

export function mountDataApi(app: Express) {
  app.post("/api/sales/query", (req: Request, res: Response) => {
    const result = answerSalesQuery(req.body, req.get("x-user-id") ?? undefined);
    res.status(httpStatus(result)).json(result);
  });

  app.get("/api/audit", (req: Request, res: Response) => {
    const limit = Number(req.query.limit ?? 30);
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 100) : 30;
    res.json({ entries: readAudit(safeLimit) });
  });

  app.get("/api/data-health", (_req: Request, res: Response) => {
    res.json(dataHealth());
  });
}
