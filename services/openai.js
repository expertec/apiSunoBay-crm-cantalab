import { OpenAI } from "openai";
import dotenv from "dotenv";
dotenv.config();  // sigue sirviendo en local, pero en Render toma la env var

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) throw new Error("Necesitas definir OPENAI_API_KEY");

export const openai = new OpenAI({ apiKey });
