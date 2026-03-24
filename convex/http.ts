import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";

const http = httpRouter();

http.route({
  path: "/api/health",
  method: "GET",
  handler: httpAction(async () => {
    return Response.json({ status: "ok" });
  }),
});

export default http;
