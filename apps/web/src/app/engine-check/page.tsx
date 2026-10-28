import { connection } from "next/server";
import { notFound } from "next/navigation";
import EngineCheckClient from "./engine-check-client";

export default async function EngineCheckPage() {
  await connection();
  if (process.env.ADOBO_ENGINE_CHECK !== "1") notFound();
  return <EngineCheckClient basePath={process.env.NEXT_PUBLIC_BASE_PATH ?? ""} />;
}
