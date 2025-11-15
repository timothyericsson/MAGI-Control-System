import { createHash, randomUUID } from "crypto";
import path from "path";
import unzipper from "unzipper";
import { getSupabaseServer } from "@/lib/supabaseClient";

export const CODE_BUCKET = "magi-code-artifacts";
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024; // 200MB

const MAX_EXPANDED_BYTES = 600 * 1024 * 1024; // allow up to ~600MB after decompression
const MAX_SINGLE_FILE_BYTES = 5 * 1024 * 1024; // skip ultra-large single files
const MAX_TEXT_FILES = 2000;
const MAX_TOTAL_CHUNKS = 4000;
const MAX_CHUNKS_PER_FILE = 64;
const CHUNK_CHAR_LIMIT = 2800;
const PRIORITY_SUFFIXES = [".html", ".htm", ".php", ".phtml", ".blade.php", ".ctp"];

export type ArtifactStatus = "uploaded" | "processing" | "ready" | "failed";

export interface MagiCodeArtifact {
	id: string;
	user_id: string;
	storage_path: string;
	original_filename: string;
	byte_length: number;
	sha256: string | null;
	status: ArtifactStatus;
	ready_at: string | null;
	manifest: Record<string, unknown> | null;
	created_at: string;
	updated_at: string;
}

export interface MagiCodeChunk {
	id: number;
	artifact_id: string;
	file_path: string;
	chunk_index: number;
	language: string | null;
	content: string;
	token_estimate: number | null;
	created_at: string;
}

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
	".ts": "typescript",
	".tsx": "typescript",
	".js": "javascript",
	".jsx": "javascript",
	".mjs": "javascript",
	".cjs": "javascript",
	".json": "json",
	".py": "python",
	".rb": "ruby",
	".go": "go",
	".rs": "rust",
	".java": "java",
	".cs": "csharp",
	".php": "php",
	".phtml": "php",
	".ctp": "php",
	".kt": "kotlin",
	".swift": "swift",
	".sh": "shell",
	".yml": "yaml",
	".yaml": "yaml",
	".md": "markdown",
	".txt": "text",
	".css": "css",
	".scss": "css",
	".less": "css",
	".sql": "sql",
	".html": "html",
	".htm": "html",
};
const MULTI_EXTENSION_LANGUAGES: Array<{ suffix: string; language: string }> = [{ suffix: ".blade.php", language: "php" }];

const SKIP_FOLDERS = new Set(["node_modules", ".git", ".next", "dist", "build", "coverage", ".turbo", "vendor"]);

function sanitizePath(raw: string): string | null {
	const normalized = path.normalize(raw).replace(/\\/g, "/");
	if (!normalized || normalized === "." || normalized.startsWith("..")) {
		return null;
	}
	const segments = normalized.split("/").filter(Boolean);
	if (segments.some((segment) => segment.startsWith("."))) {
		// allow dotfiles but skip dot-directories that might hide metadata
		const sanitizedSegments = segments.filter((segment) => segment !== "." && segment !== "..");
		return sanitizedSegments.join("/");
	}
	return segments.join("/");
}

function detectLanguage(filePath: string): string {
	const lower = filePath.toLowerCase();
	for (const entry of MULTI_EXTENSION_LANGUAGES) {
		if (lower.endsWith(entry.suffix)) return entry.language;
	}
	const ext = path.extname(lower);
	return LANGUAGE_BY_EXTENSION[ext] || "text";
}

function isPriorityPath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	return PRIORITY_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

function isSkippablePath(filePath: string): boolean {
	const lower = filePath.toLowerCase();
	if (lower.includes("__pycache__")) return true;
	const parts = filePath.split("/");
	return parts.some((part) => SKIP_FOLDERS.has(part));
}

function isLikelyBinary(buf: Buffer): boolean {
	const sample = buf.subarray(0, Math.min(buf.length, 4096));
	let suspicious = 0;
	for (const byte of sample) {
		if (byte === 0) return true;
		if (byte < 7 || (byte > 13 && byte < 32)) suspicious += 1;
	}
	return sample.length > 0 && suspicious / sample.length > 0.25;
}

function chunkContent(content: string): string[] {
	const lines = content.split(/\r?\n/);
	const chunks: string[] = [];
	let buffer: string[] = [];
	let length = 0;
	for (const line of lines) {
		const candidateLength = length + line.length + 1;
		if (candidateLength > CHUNK_CHAR_LIMIT && buffer.length > 0) {
			chunks.push(buffer.join("\n").trimEnd());
			if (chunks.length >= MAX_CHUNKS_PER_FILE) {
				buffer = [];
				length = 0;
				break;
			}
			buffer = [];
			length = 0;
		}
		buffer.push(line);
		length += line.length + 1;
	}
	if (buffer.length > 0 && chunks.length < MAX_CHUNKS_PER_FILE) {
		chunks.push(buffer.join("\n").trimEnd());
	}
	return chunks.filter((c) => c.trim().length > 0);
}

function estimateTokens(text: string): number {
	return Math.ceil(text.length / 4);
}

function summarizeFiles(files: { path: string; language: string; bytes: number; chunks: number }[]) {
	return files
		.sort((a, b) => b.bytes - a.bytes)
		.slice(0, 20)
		.map((f) => ({
			path: f.path,
			language: f.language,
			bytes: f.bytes,
			chunks: f.chunks,
		}));
}

export async function createArtifactRecord(params: {
	userId: string;
	filename: string;
	byteLength: number;
}): Promise<MagiCodeArtifact> {
	const supabase = getSupabaseServer();
	const id = randomUUID();
	const storagePath = `${params.userId}/${id}.zip`;

	const { data, error } = await supabase
		.from("magi_code_artifacts")
		.insert([
			{
				id,
				user_id: params.userId,
				original_filename: params.filename,
				byte_length: params.byteLength,
				storage_path: storagePath,
				status: "uploaded",
			},
		])
		.select("*")
		.single();
	if (error) throw error;
	return data as unknown as MagiCodeArtifact;
}

export async function getArtifactById(id: string): Promise<MagiCodeArtifact | null> {
	const supabase = getSupabaseServer();
	const { data, error } = await supabase.from("magi_code_artifacts").select("*").eq("id", id).maybeSingle();
	if (error) throw error;
	return (data as MagiCodeArtifact | null) ?? null;
}

export async function updateArtifact(id: string, patch: Partial<MagiCodeArtifact>) {
	const supabase = getSupabaseServer();
	const { error } = await supabase.from("magi_code_artifacts").update(patch).eq("id", id);
	if (error) throw error;
}

export async function deleteChunksForArtifact(artifactId: string) {
	const supabase = getSupabaseServer();
	const { error } = await supabase.from("magi_code_chunks").delete().eq("artifact_id", artifactId);
	if (error) throw error;
}

export async function insertChunks(chunks: Array<Omit<MagiCodeChunk, "id" | "created_at">>) {
	if (chunks.length === 0) return;
	const supabase = getSupabaseServer();
	const batchSize = 50;
	for (let i = 0; i < chunks.length; i += batchSize) {
		const batch = chunks.slice(i, i + batchSize);
		const { error } = await supabase.from("magi_code_chunks").insert(batch);
		if (error) throw error;
	}
}

export async function listArtifactChunks(artifactId: string, limit = 40, languages?: string[]): Promise<MagiCodeChunk[]> {
	const supabase = getSupabaseServer();
	let query = supabase.from("magi_code_chunks").select("*").eq("artifact_id", artifactId);
	if (languages && languages.length > 0) {
		query = query.in("language", languages);
	}
	const { data, error } = await query.order("chunk_index", { ascending: true }).limit(limit);
	if (error) throw error;
	return (data as unknown as MagiCodeChunk[]) || [];
}

export async function buildArtifactContextText(artifactId: string, maxChars = 32000): Promise<string | null> {
	const artifact = await getArtifactById(artifactId);
	if (!artifact || !artifact.manifest) return null;
	const manifestSummary = artifact.manifest as Record<string, any>;
	const manifestLines: string[] = [];
	manifestLines.push(`Uploaded bundle: ${artifact.original_filename}`);
	if (typeof manifestSummary.totalFiles === "number") {
		manifestLines.push(
			`Files processed: ${manifestSummary.processedFiles ?? manifestSummary.totalFiles} (skipped ${manifestSummary.skippedFiles ?? 0})`
		);
	}
	if (manifestSummary.languages && typeof manifestSummary.languages === "object") {
		const topLangs = Object.entries(manifestSummary.languages as Record<string, number>)
			.sort((a, b) => b[1] - a[1])
			.slice(0, 5)
			.map(([lang, count]) => `${lang}(${count})`);
		if (topLangs.length) {
			manifestLines.push(`Languages: ${topLangs.join(", ")}`);
		}
	}
	if (Array.isArray(manifestSummary.topFiles)) {
		const topFiles = (manifestSummary.topFiles as Array<Record<string, any>>)
			.slice(0, 5)
			.map((f: any) => `${f.path} (${f.language || "text"})`)
			.join("; ");
		if (topFiles) manifestLines.push(`Key files: ${topFiles}`);
	}

	const priorityChunks = await listArtifactChunks(artifactId, 400, ["html", "php"]);
	const generalChunks = await listArtifactChunks(artifactId, 200);
	const seenChunkIds = new Set<number>();
	const combinedChunks: MagiCodeChunk[] = [];
	for (const chunk of priorityChunks) {
		if (!chunk) continue;
		seenChunkIds.add(chunk.id);
		combinedChunks.push(chunk);
	}
	for (const chunk of generalChunks) {
		if (!chunk || seenChunkIds.has(chunk.id)) continue;
		seenChunkIds.add(chunk.id);
		combinedChunks.push(chunk);
	}
	if (!combinedChunks.length) return manifestLines.join("\n");
	const chunkLines: string[] = [];
	let totalChars = manifestLines.join("\n").length;
	for (const chunk of combinedChunks) {
		const header = `File: ${chunk.file_path} [chunk ${chunk.chunk_index + 1}]`;
		const body = chunk.content.trim();
		const snippet = `${header}\n${body}`;
		if (totalChars + snippet.length > maxChars) break;
		chunkLines.push(snippet);
		totalChars += snippet.length + 4;
	}
	return [manifestLines.join("\n"), chunkLines.join("\n\n")].filter(Boolean).join("\n\n");
}

export async function processArtifactZip(artifact: MagiCodeArtifact) {
	const supabase = getSupabaseServer();
	const download = await supabase.storage.from(CODE_BUCKET).download(artifact.storage_path);
	if (download.error) {
		throw new Error(download.error.message);
	}
	const blob = download.data;
	if (!blob) throw new Error("Uploaded archive missing in storage");
	const arrayBuffer = await blob.arrayBuffer();
	const zipBuffer = Buffer.from(arrayBuffer);

	const sha256 = createHash("sha256").update(zipBuffer).digest("hex");

	const zip = await unzipper.Open.buffer(zipBuffer);
	let processedBytes = 0;
	let processedFiles = 0;
	let skippedFiles = 0;
	const languageCounts: Record<string, number> = {};
	const fileSummaries: { path: string; language: string; bytes: number; chunks: number }[] = [];
	const chunkRecords: Array<Omit<MagiCodeChunk, "id" | "created_at">> = [];

	const priorityEntries: typeof zip.files = [];
	const fallbackEntries: typeof zip.files = [];
	for (const entry of zip.files) {
		if (entry.type !== "File") continue;
		if (isPriorityPath(entry.path)) priorityEntries.push(entry);
		else fallbackEntries.push(entry);
	}
	const orderedEntries = [...priorityEntries, ...fallbackEntries];

	for (const entry of orderedEntries) {
		if (entry.type !== "File") continue;
		if (processedFiles >= MAX_TEXT_FILES || chunkRecords.length >= MAX_TOTAL_CHUNKS) {
			skippedFiles += 1;
			continue;
		}

		const cleanedPath = sanitizePath(entry.path);
		if (!cleanedPath || isSkippablePath(cleanedPath)) {
			skippedFiles += 1;
			continue;
		}

		if (entry.uncompressedSize > MAX_SINGLE_FILE_BYTES) {
			skippedFiles += 1;
			continue;
		}

		if (processedBytes + entry.uncompressedSize > MAX_EXPANDED_BYTES) {
			skippedFiles += 1;
			continue;
		}

		const fileBuffer = await entry.buffer();
		if (!fileBuffer || !fileBuffer.length) {
			skippedFiles += 1;
			continue;
		}

		if (isLikelyBinary(fileBuffer)) {
			skippedFiles += 1;
			continue;
		}

		const text = fileBuffer.toString("utf-8").replace(/\u0000/g, "");
		if (!text.trim()) {
			skippedFiles += 1;
			continue;
		}

		processedFiles += 1;
		processedBytes += fileBuffer.length;

		const language = detectLanguage(cleanedPath);
		languageCounts[language] = (languageCounts[language] || 0) + 1;
		const chunks = chunkContent(text);
		const limitedChunks = chunks.slice(0, Math.min(MAX_CHUNKS_PER_FILE, MAX_TOTAL_CHUNKS - chunkRecords.length));
		fileSummaries.push({
			path: cleanedPath,
			language,
			bytes: fileBuffer.length,
			chunks: limitedChunks.length,
		});

		limitedChunks.forEach((chunk, idx) => {
			chunkRecords.push({
				artifact_id: artifact.id,
				file_path: cleanedPath,
				chunk_index: idx,
				language,
				content: chunk,
				token_estimate: estimateTokens(chunk),
			});
		});
	}

	await deleteChunksForArtifact(artifact.id);
	await insertChunks(chunkRecords);

	const manifest = {
		totalFiles: zip.files.length,
		processedFiles,
		skippedFiles,
		languages: languageCounts,
		topFiles: summarizeFiles(fileSummaries),
		chunksStored: chunkRecords.length,
		truncated: processedFiles >= MAX_TEXT_FILES || chunkRecords.length >= MAX_TOTAL_CHUNKS,
	};

	await updateArtifact(artifact.id, {
		status: "ready" as ArtifactStatus,
		sha256,
		ready_at: new Date().toISOString(),
		manifest,
		updated_at: new Date().toISOString(),
	});
}


