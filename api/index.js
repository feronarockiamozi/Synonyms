const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const fileUpload = require('express-fileupload');
const Anthropic = require('@anthropic-ai/sdk');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const { GoogleGenAI } = require('@google/genai');
const dotenv = require('dotenv');
const xlsx = require('xlsx');
const { algoliasearch } = require('algoliasearch');

if (process.env.NODE_ENV !== 'production') {
    dotenv.config({ path: path.join(__dirname, '..', '.env') });
}

const { connectDB, Cluster, Metric, Job, getMetrics, updateMetrics, getSynonymCounts } = require('./db');

const app = express();
app.use(cors());
// Increase payload limit for massive term pastes
app.use(express.json({ limit: '50mb' }));
app.use(fileUpload());
app.use(express.static(path.join(__dirname, '..', 'public')));

// GLOBAL DB MIDDLEWARE: Ensure connection is ready before routing API calls
app.use('/api', async (req, res, next) => {
    try {
        await connectDB();
        next();
    } catch (err) {
        console.error('Middleware DB Error:', err);
        res.status(500).json({ error: 'Database connection failed: ' + err.message });
    }
});

const PORT = process.env.PORT || process.env.MANAGER_PORT || 4001;

// AUTH: Claude
const anthropic = new Anthropic({ apiKey: process.env.CLAUDE_API_KEY });

// AUTH: Gemini (Vertex AI - Unified SDK)
let genaiClient;
try {
    if (process.env.GEMINI_API_KEY) {
        // AUTH: API Key (Standalone mode / Google AI Studio)
        // MUST use string constructor to avoid "mutually exclusive" error with Vertex parameters
        genaiClient = new GoogleGenAI(process.env.GEMINI_API_KEY);
        console.log('Gemini initialized with API Key string.');
    } else {
        const credsPath = path.join(__dirname, '..', 'data', 'creds.json');
        let credentials;
        if (process.env.GOOGLE_CREDS_JSON) {
            credentials = JSON.parse(process.env.GOOGLE_CREDS_JSON);
        } else if (fs.existsSync(credsPath)) {
            credentials = require(credsPath);
        }

        if (credentials) {
            // AUTH: Service Account (Vertex AI mode)
            // For @google/genai, Vertex mode is triggered by project/location.
            // Authentication is usually handled via ADC or credentials object.
            genaiClient = new GoogleGenAI({
                project: credentials.project_id,
                location: 'us-central1'
            });
            console.log('Gemini initialized with Service Account (Vertex AI).');
        }
    }
} catch (e) {
    console.warn('Gemini init failed:', e.message);
}

// ─────────────────────────────────────────────────────────
// HARDCODED PROMPTS (Vercel Stability Fix)
// ─────────────────────────────────────────────────────────
const synonymsPrompt = `You generate **product synonym clusters for an ecommerce search engine**.

Domain: **baby, kids, and family shopping products in India**.

The goal is to identify **different names users use for the SAME product when searching**.

These synonyms will be used to **normalize search queries** so that different terms retrieve the same products.

Return **ONLY valid JSON**.

---

# TASK

Given a **product type**, generate **alternate names that refer to the exact same product**.

A synonym must satisfy ALL of the following:

• refers to the **same physical product**
• represents the **same purchase intent**
• belongs to the **same product category**

All synonyms must be **interchangeable in search results**.

---

# SYNONYM VALIDATION RULE

A term is a valid synonym only if the following test passes:

"If a user searches this term, they expect to see the same products."

Example:

Concept: feeding bottle

Valid synonyms:

feeding bottle
baby bottle
milk bottle

Invalid:

bottle nipple (accessory)
bottle sterilizer (different product)

---

# STRICT RULES

## 1. Same product only

Do NOT generate:

• accessories
• spare parts
• bundles
• related items

Example:

Concept: stroller

Valid:
stroller
baby stroller
baby pram

Invalid:
stroller rain cover
stroller organizer bag

---

## 2. Avoid generic parent categories

Do NOT generate overly generic terms.

Invalid examples:

toy
container
carrier
vehicle

These are broader categories and will produce incorrect search results.

---

## 3. Allow natural product phrases

Short product phrases are allowed if they still refer to the same item.

Valid examples:

tiffin carrier -> lunch box
milk bottle -> feeding bottle
water pistol -> water gun

---

## 4. Use realistic shopping language

Synonyms should look like **real ecommerce search queries**.

Avoid descriptive phrases.

Bad:

plastic feeding bottle for newborn baby

Good:

feeding bottle
baby bottle

---

## 5. Term length rules

Each synonym must be:

• 1–3 words
• concise product naming

---

## 6. Avoid descriptive search queries

Do NOT generate phrases like:

toy car for kids
feeding bottle for baby

These are **search queries**, not product synonyms.

---

# OUTPUT LIMIT

Return **3–6 synonyms maximum**.

Prioritize **high-confidence common names**.

---

# OUTPUT FORMAT

{
"product_type": "input product type",
"synonyms": [
"synonym 1",
"synonym 2",
"synonym 3"
]
}`;

const regionalPrompt = `You generate **Indian regional product name variations for an ecommerce search engine**.

Domain: **baby, kids, and family shopping products in India**.

The goal is to identify **informal names or colloquial product terms people in India might type when searching for this product**.

These variations help map **different cultural or regional names to the same product**.

Return **ONLY JSON**.

---

# TASK

Given a product type, generate **informal product names commonly used in Indian shopping language**.

These may include:

• Hinglish terms
• colloquial retail names
• common Indian English variations
• occasionally other Indian regional language terms if they are widely used in retail search

All terms must be written using **Roman alphabet (English letters)**.

---

# LANGUAGE GUIDELINES

Focus primarily on:

• English
• Hinglish (Hindi words written in English letters)

Examples:

feeding bottle -> doodh bottle
vest -> baniyan
lunch box -> dabba

You may include **other Indian regional language terms** only if they are **commonly used in shopping search**.

Example:

swing -> jhula
cap -> topi
footwear -> chappal

Do NOT generate rare translations.

---

# IMPORTANT RULE

A variation is valid only if:

"If a user searches this word, they expect to see this product."

Example:

Concept: lunch box

Valid:

tiffin
tiffin box
dabba

---

# STRICT RULES

1. Do NOT translate the product literally.

Invalid:

food container
milk drinking bottle
cloth used for burping

These are **descriptions**, not product names.

---

2. Avoid long phrases.

Each variation must be:

• 1–3 words
• short and natural

---

3. Avoid descriptive search queries.

Invalid:

feeding bottle for baby
toy car for kids

---

4. Avoid unrelated products.

Example:

Concept: pacifier

Invalid:

teether

---

5. If no commonly used regional variations exist, return an empty list.

Do NOT invent words.

---

# OUTPUT LIMIT

Return **2–5 regional variations maximum**.

---

# OUTPUT FORMAT

{
"product_type": "input product type",
"regional_variations": [
"variation 1",
"variation 2",
"variation 3"
]
}

---

# EXAMPLES

Example 1

Input:

lunch box

Output:

{
"product_type": "lunch box",
"regional_variations": [
"tiffin",
"tiffin box",
"dabba"
]
}

---

Example 2

Input:

vest

Output:

{
"product_type": "vest",
"regional_variations": [
"baniyan",
"banian"
]
}

---

Example 3

Input:

water gun

Output:

{
"product_type": "water gun",
"regional_variations": [
"pichkari",
"holi pichkari"
]
}

]
}

---

Example 4

Input:

feeding bottle

Output:

{
"product_type": "feeding bottle",
"regional_variations": [
"doodh bottle",
"paal bottle"
]
}`;

const brandSynonymsPrompt = `You generate **brand and generic name variations for an ecommerce search engine**.

Domain: **pharmacy, health, baby, kids, and family products in India**.

The goal is to identify **common naming permutations, generic equivalents, and spelling variations** users might search for instead of the exact brand name.

Return **ONLY valid JSON**.

---

# TASK

Given a **Brand Name or Generic/Chemical Name**, generate alternate names that refer to the exact same product.

A synonym must be:
- The common chemical/generic name for that brand.
- Common misspellings (e.g. cetzine -> cetrizine).
- Shorthand names.

Return **3-6 synonyms maximum**.

# OUTPUT FORMAT

{
"product_type": "input term",
"synonyms": [
"synonym 1",
"synonym 2"
]
}`;

const brandRegionalPrompt = `You generate **colloquial or regional variations for brand names** in Indian ecommerce.

Domain: **pharmacy, health, baby, kids, and family products in India**.

The goal is to identify **highly localized, slang, or heavily localized mispronunciations** of brand names and medicines. If no commonly used regional variations exist, return an empty list.

Return **ONLY valid JSON**.

# OUTPUT FORMAT

{
"product_type": "input term",
"regional_variations": [
"variation 1"
]
}`;

// ─────────────────────────────────────────────────────────
// STATE & JOBS (Stateless via MongoDB)
// ─────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────
// SHARED UTILS
// ─────────────────────────────────────────────────────────

function buildBatchPrompt(baseRules, terms, fieldName) {
    const list = terms.map(t => `- ${t}`).join('\n');
    return `${baseRules}\n\n# BATCH PROCESSING TASK\nGenerate variations for EACH of the following terms:\n${list}\n\nCRITICAL RULE: Return ONLY a single raw JSON object — no markdown, no backticks, no explanations.\n\nEXACT FORMAT:\n{\n  "results": [\n    { "product_type": "term1", "${fieldName}": ["var1", "var2"] }\n  ]\n}`;
}

async function callClaudeBatch(terms, promptBase, fieldName) {
    const prompt = buildBatchPrompt(promptBase, terms, fieldName);
    const response = await anthropic.messages.create({
        model: 'claude-haiku-4-5',
        max_tokens: 4096,
        system: 'You are an expert in Indian ecommerce search behavior. Return ONLY raw JSON. No markdown, no code blocks, no extra text.',
        messages: [{ role: 'user', content: prompt }],
    });

    const inputTokens = response.usage?.input_tokens || 0;
    const outputTokens = response.usage?.output_tokens || 0;
    const content = response.content[0].text;

    const jsonMatch = content.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in Claude response.`);

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed.results)) throw new Error('Missing "results" array.');
        return { data: parsed, inputTokens, outputTokens };
    } catch (e) {
        throw new Error(`JSON parse error.`);
    }
}

async function callGeminiBatch(terms, promptBase, fieldName) {
    const prompt = buildBatchPrompt(promptBase, terms, fieldName);

    // Unified Gen AI SDK (Vertex Mode)
    const result = await genaiClient.models.generateContent({
        model: "gemini-3-flash-preview",
        contents: [{ role: 'user', parts: [{ text: prompt }] }],
        config: {
            systemInstruction: "You are an expert in Indian ecommerce search behavior. Return ONLY raw JSON. No markdown, no code blocks, no extra text."
        }
    });

    // Check if candidates exist
    if (!result.candidates || !result.candidates[0]) {
        throw new Error('Gemini response returned no candidates.');
    }

    const responseText = result.candidates[0].content.parts[0].text;
    const usage = result.usageMetadata || {};
    const inputTokens = usage.promptTokenCount || 0;
    const outputTokens = usage.candidatesTokenCount || 0;

    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`No JSON in Gemini response.`);

    try {
        const parsed = JSON.parse(jsonMatch[0]);
        if (!Array.isArray(parsed.results)) throw new Error('Missing "results" array.');
        return { data: parsed, inputTokens, outputTokens };
    } catch (e) {
        throw new Error(`JSON parse error from Gemini.`);
    }
}

function normalizePTypes(rawLines) {
    const exclusionWords = ['piece', 'kit', 'set', 'experiment', 'pack', 'color', 'pretend play', 'activity', 'doodle', 'magic'];
    const conceptMap = new Map(); // key -> { canonical, variations: Set }

    for (const line of rawLines) {
        let trimmed = line.trim();
        if (!trimmed) continue;
        let lower = trimmed.toLowerCase();

        // Strip non-essential descriptive suffixes
        if (lower.split(/\s+/).length > 3 && exclusionWords.some(ex => lower.includes(ex))) continue;

        const key = lower.replace(/[\s\-\_\/]+/g, '');

        if (!conceptMap.has(key)) {
            conceptMap.set(key, { canonical: trimmed, variations: new Set([trimmed]) });
        } else {
            conceptMap.get(key).variations.add(trimmed);
        }
    }

    // Return objects: { product_type: "play mat", variations: ["play mat", "playmat"] }
    return Array.from(conceptMap.values()).map(c => ({
        product_type: c.canonical,
        variations: Array.from(c.variations)
    }));
}

async function splitByCache(terms) {
    if (terms.length === 0) return { existing: [], missing: [] };
    try {
        const rows = await Cluster.find({
            product_type: { $in: terms.map(t => new RegExp(`^${t}$`, 'i')) }
        });
        const existingKeys = new Set(rows.map(r => r.product_type.toLowerCase()));
        return {
            existing: rows,
            missing: terms.filter(t => !existingKeys.has(t.toLowerCase())),
        };
    } catch (e) {
        throw e;
    }
}

function mergeResults(terms, synResult, regResult, source, model) {
    return terms.map(term => {
        const synFound = synResult.data.results.find(r => r.product_type.toLowerCase() === term.toLowerCase());
        const regFound = regResult.data.results.find(r => r.product_type.toLowerCase() === term.toLowerCase());
        const synonyms = synFound?.synonyms || [];
        const regional_variations = regFound?.regional_variations || [];
        const clusterSet = new Set([
            term.toLowerCase(),
            ...synonyms.map(s => s.toLowerCase()),
            ...regional_variations.map(s => s.toLowerCase()),
        ]);
        return { 
            product_type: term, 
            synonyms, 
            regional_variations, 
            cluster_terms: Array.from(clusterSet), 
            source,
            llm: model 
        };
    });
}

// ─────────────────────────────────────────────────────────
// API ROUTES
// ─────────────────────────────────────────────────────────

app.get('/api/metrics', async (req, res) => {
    try {
        const stats = await getMetrics();
        const counts = await getSynonymCounts();
        res.json({ ...stats, ...counts });
    }
    catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/api/history', async (req, res) => {
    try {
        const rows = await Cluster.find({ status: 'approved' }).sort({ updated_at: -1 });
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.delete('/api/history/:product_type', async (req, res) => {
    const product_type = req.params.product_type;
    try {
        const result = await Cluster.deleteOne({ product_type });
        res.json({ success: true, deleted: result.deletedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/drafts', async (req, res) => {
    try {
        const rows = await Cluster.find({ status: 'draft' }).sort({ updated_at: -1 });
        res.json(rows);
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/approve', async (req, res) => {
    const { product_type, synonyms, regional_variations, cluster_terms, source, variations } = req.body;
    const targets = (variations && variations.length > 0) ? variations : [product_type];

    try {
        const promises = targets.map(target => {
            const finalCluster = Array.from(new Set([target.toLowerCase(), ...cluster_terms]));
            return Cluster.findOneAndUpdate(
                { product_type: target },
                {
                    synonyms,
                    regional_variations,
                    cluster_terms: finalCluster,
                    status: 'approved',
                    source: source || 'custom',
                    updated_at: Date.now()
                },
                { upsert: true }
            );
        });

        await Promise.all(promises);
        res.json({ success: true, count: targets.length });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Bulk Approve All Drafts
app.post('/api/approve-all', async (req, res) => {
    try {
        const result = await Cluster.updateMany(
            { status: 'draft' },
            { $set: { status: 'approved', updated_at: Date.now() } }
        );
        res.json({ success: true, count: result.modifiedCount });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Create Job for Custom or Index
app.post('/api/jobs', async (req, res) => {
    const { type, terms, model, promptProfile } = req.body;
    const jobId = Date.now().toString() + Math.random().toString().substring(2, 6);

    try {
        await Job.create({
            job_id: jobId,
            type,
            terms: terms || [],
            mode: type === 'index' ? 'catalog' : 'custom',
            model: model || 'claude',
            promptProfile: promptProfile || 'ptype'
        });
        res.json({ jobId });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// SSE Streaming Execution
app.get('/api/jobs/:id/stream', async (req, res) => {
    const jobId = req.params.id;

        let isAborted = false;
        const send = (type, data) => {
            if (!isAborted && !res.writableEnded) {
                res.write(`data: ${JSON.stringify({ type, ...data })}\n\n`);
            }
        };

        try {
            const job = await Job.findOne({ job_id: jobId });
            if (!job) return res.status(404).send('Job not found in DB');

            // Delete job to prevent re-execution or duplicate streaming
            await Job.deleteOne({ job_id: jobId });

            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            res.flushHeaders();

            req.on('close', () => { isAborted = true; });

            let rawTerms = [];

        // 1. Gather all terms
        if (job.type === 'index') {
            send('status', { message: 'Loading p_types from unique_ptypes.txt...' });
            const filePath = path.join(__dirname, '..', 'data', 'unique_ptypes.txt');
            if (fs.existsSync(filePath)) {
                rawTerms = fs.readFileSync(filePath, 'utf8').split('\n');
            } else {
                throw new Error('unique_ptypes.txt not found in bundled data folder');
            }
        } else {
            rawTerms = job.terms;
        }

        if (isAborted) return res.end();

        // 2. Normalize and Group by Concept
        const allCanonical = normalizePTypes(rawTerms);

        // 3. Check Cache
        const canonicalTerms = allCanonical.map(c => c.product_type);
        const { existing, missing: pendingCanonical } = await splitByCache(canonicalTerms);

        let processed = existing.length;
        let total = allCanonical.length;

        send('progress', {
            message: `Cache check complete. ${existing.length} concepts cached. ${pendingCanonical.length} to process.`,
            total,
            done: processed
        });

        if (isAborted) return res.end();

        // 4. Send the Cached Results instantly
        if (existing.length > 0) {
            const formattedExisting = existing.map(r => ({
                product_type: r.product_type,
                synonyms: r.synonyms,
                regional_variations: r.regional_variations,
                cluster_terms: r.cluster_terms,
                source: 'cache',
                variations: [r.product_type]
            }));
            send('batch_result', { results: formattedExisting, tokens: 0, done: processed, total });
        }

        if (pendingCanonical.length === 0) {
            send('done', { message: 'All terms processed!', done: processed, total });
            return res.end();
        }

        // Mapping to get variation data back easily
        const conceptDataMap = new Map(allCanonical.map(c => [c.product_type, c.variations]));

        // 5. Uncapped Batched Processing
        const BATCH_SIZE = 6;

        for (let i = 0; i < pendingCanonical.length; i += BATCH_SIZE) {
            if (isAborted) break;

            const batch = pendingCanonical.slice(i, i + BATCH_SIZE);
            send('status', { message: `Processing concepts: [${batch.join(', ')}]` });

            try {
                const processor = job.model === 'gemini' ? callGeminiBatch : callClaudeBatch;
                const pSyn = job.promptProfile === 'brand' ? brandSynonymsPrompt : synonymsPrompt;
                const pReg = job.promptProfile === 'brand' ? brandRegionalPrompt : regionalPrompt;
                const [synResult, regResult] = await Promise.all([
                    processor(batch, pSyn, 'synonyms'),
                    processor(batch, pReg, 'regional_variations'),
                ]);

                if (isAborted) break;

                const inputTokens = synResult.inputTokens + regResult.inputTokens;
                const outputTokens = synResult.outputTokens + regResult.outputTokens;
                await updateMetrics(inputTokens, outputTokens, 2, job.model);

                const results = mergeResults(batch, synResult, regResult, job.mode, job.model);

                results.forEach(item => {
                    item.variations = conceptDataMap.get(item.product_type) || [item.product_type];
                });

                const generatorLlm = job.model === 'gemini' ? 'Gemini' : 'Claude';
                for (let item of results) {
                    for (let target of item.variations) {
                        const finalCluster = Array.from(new Set([target.toLowerCase(), ...item.cluster_terms]));
                        await Cluster.findOneAndUpdate(
                            { product_type: target },
                            {
                                synonyms: item.synonyms,
                                regional_variations: item.regional_variations,
                                cluster_terms: finalCluster,
                                status: 'draft',
                                source: item.source,
                                llm: generatorLlm,
                                updated_at: Date.now()
                            },
                            { upsert: true }
                        );
                    }
                }

                processed += batch.length;
                send('batch_result', { results, tokens: (inputTokens + outputTokens), done: processed, total });
            } catch (batchErr) {
                console.error(batchErr);
                send('batch_error', { terms: batch, message: batchErr.message, done: processed, total });
                processed += batch.length;
            }
        }

        if (!isAborted) {
            send('done', { message: `Pipeline complete.`, done: processed, total });
        }
    } catch (err) {
        console.error('[SSE]', err.message);
        if (!res.headersSent) {
            res.status(500).json({ error: err.message });
        } else {
            send('error', { message: err.message });
        }
    } finally {
        res.end();
    }
});

// ─── ALGOLIA SYNC ─────────────────────────────────────────
app.post('/api/sync-algolia', async (req, res) => {
    try {
        const rows = await Cluster.find({ status: 'approved' });
        if (!rows.length) return res.json({ success: false, message: 'No approved records to sync.' });

        const appId = process.env.ALGOLIA_APP_ID;
        const apiKey = process.env.ALGOLIA_WRITE_KEY;
        if (!appId || !apiKey) {
            return res.status(500).json({ error: 'ALGOLIA_APP_ID and ALGOLIA_WRITE_KEY must be set in environment variables.' });
        }

        const client = algoliasearch(appId, apiKey);

        const PRODUCT_INDEX = process.env.ALGOLIA_PRODUCT_INDEX || 'products-poc';
        const MATCH_THRESHOLD = 0;
        
        console.log(`Preparing dynamic synonym classification against ${PRODUCT_INDEX}...`);
        
        const termsArray = rows.flatMap(r => [
            r.product_type,
            ...(r.synonyms || []),
            ...(r.regional_variations || [])
        ]);

        const allUniqueTerms = [...new Set(termsArray)].filter(t => t && String(t).trim().length > 0);
        
        const termHits = {};
        const SEARCH_CHUNK = 50;
        for (let i = 0; i < allUniqueTerms.length; i += SEARCH_CHUNK) {
            const chunk = allUniqueTerms.slice(i, i + SEARCH_CHUNK);
            const searchRes = await client.search({
                requests: chunk.map(t => ({ 
                    indexName: PRODUCT_INDEX, 
                    query: t, 
                    hitsPerPage: 1,
                    typoTolerance: false,
                    queryType: 'prefixNone',
                    analytics: false,
                    synonyms: false,
                    ignorePlurals: false
                }))
            });
            chunk.forEach((t, idx) => {
                termHits[t] = searchRes.results[idx].nbHits;
            });
        }

        const dashboardObjects = [];
        const synonymRules = [];

        rows.forEach(r => {
            const pt = r.product_type;
            const variations = [...new Set([
                ...(r.synonyms || []),
                ...(r.regional_variations || [])
            ])];

            const twoWayGroup = [pt];
            const oneWayGroup = [];

            variations.forEach(v => {
                if (v.toLowerCase() === pt.toLowerCase()) return;
                if (termHits[v] > MATCH_THRESHOLD) {
                    twoWayGroup.push(v);
                } else {
                    oneWayGroup.push(v);
                }
            });

            if (twoWayGroup.length > 1) {
                synonymRules.push({
                    objectID: `syn-${String(r._id)}-twoway`,
                    type: 'synonym',
                    synonyms: twoWayGroup
                });
            }

            oneWayGroup.forEach((v, idx) => {
                synonymRules.push({
                    objectID: `syn-${String(r._id)}-oneway-${idx}`,
                    type: 'oneWaySynonym',
                    input: v,
                    synonyms: [pt]
                });
            });

            dashboardObjects.push({
                objectID: String(r._id),
                product_type: pt,
                synonyms: [pt, ...variations],
                source: r.source,
                llm: r.llm,
                twoWayCount: twoWayGroup.length > 1 ? twoWayGroup.length : 0,
                oneWayCount: oneWayGroup.length,
                updatedAt: r.updatedAt ? new Date(r.updatedAt).getTime() : Date.now()
            });
        });

        const DASHBOARD_INDEX = 'Synonyms-Index';
        const CHUNK_SIZE = 1000;
        console.log(`Syncing ${dashboardObjects.length} cluster records to preview index "${DASHBOARD_INDEX}"...`);
        for (let i = 0; i < dashboardObjects.length; i += CHUNK_SIZE) {
            const chunk = dashboardObjects.slice(i, i + CHUNK_SIZE);
            await client.saveObjects({ indexName: DASHBOARD_INDEX, objects: chunk });
        }

        console.log(`Syncing ${synonymRules.length} semantic rules to catalog "${PRODUCT_INDEX}"...`);
        if (synonymRules.length > 0) {
            for (let i = 0; i < synonymRules.length; i += CHUNK_SIZE) {
                const chunk = synonymRules.slice(i, i + CHUNK_SIZE);
                await client.saveSynonyms({
                    indexName: PRODUCT_INDEX,
                    synonymHit: chunk,
                    replaceExistingSynonyms: i === 0 // Only replace on the first chunk
                });
            }
        }

        res.json({ success: true, count: dashboardObjects.length, ruleCount: synonymRules.length });
    } catch (err) {
        console.error('Algolia Sync Error:', err);
        res.status(500).json({ error: 'Algolia Sync Failed: ' + err.message });
    }
});

app.get('/api/algolia/stats', async (req, res) => {
    try {
        const appId = process.env.ALGOLIA_APP_ID;
        const apiKey = process.env.ALGOLIA_API_KEY;
        if (!appId || !apiKey) {
            return res.status(500).json({ error: 'ALGOLIA_APP_ID and ALGOLIA_API_KEY must be set in environment variables.' });
        }

        const client = algoliasearch(appId, apiKey);

        // Fetch up to 100 records as a live preview
        const searchRes = await client.searchSingleIndex({
            indexName: 'Synonyms-Index',
            searchParams: { hitsPerPage: 100, query: '' }
        });

        const items = {};
        let totalSynonymsSample = 0;
        searchRes.hits.forEach(hit => {
            items[hit.product_type] = hit.synonyms || [];
            totalSynonymsSample += Array.isArray(hit.synonyms) ? hit.synonyms.length : 0;
        });

        res.json({
            success: true,
            count: searchRes.nbHits,
            totalSynonyms: searchRes.nbHits > 100
                ? `${totalSynonymsSample}+ (Top 100 Sample)`
                : totalSynonymsSample,
            items,
            timestamp: new Date().toISOString()
        });
    } catch (err) {
        res.status(500).json({ error: 'Algolia Stats Failed: ' + err.message });
    }
});

// ─────────────────────────────────────────────────────────
// EXPORTS
// ─────────────────────────────────────────────────────────

app.get('/api/export', async (req, res) => {
    const { format, scope, expand } = req.query;
    const shouldExpand = expand === 'true';

    try {
        let filter = {};
        if (scope === 'approved') filter.status = 'approved';
        else if (scope === 'draft') filter.status = 'draft';

        const rows = await Cluster.find(filter).sort({ product_type: 1 });
        const filename = `synonyms_${scope}_${new Date().toISOString().split('T')[0]}`;

        let exportData = [];
        if (shouldExpand) {
            rows.forEach(r => {
                const syns = r.synonyms || [];
                const regs = r.regional_variations || [];
                const allTerms = [...new Set([...syns, ...regs])];

                if (allTerms.length === 0) {
                    exportData.push(r);
                } else {
                    allTerms.forEach(term => {
                        exportData.push({
                            ...r.toObject(),
                            synonym_term: term
                        });
                    });
                }
            });
        } else {
            exportData = rows.map(r => r.toObject());
        }

        if (format === 'txt') {
            let content = shouldExpand
                ? 'Product Type | Synonym/Variation | Status | Generator\n' + '='.repeat(80) + '\n'
                : 'Product Type | Cluster Terms | Status | Generator\n' + '='.repeat(90) + '\n';

            exportData.forEach(r => {
                if (shouldExpand) {
                    content += `${r.product_type.padEnd(25)} | ${r.synonym_term.padEnd(25)} | ${r.status.padEnd(8)} | ${r.llm || 'Claude'}\n`;
                } else {
                    const terms = r.cluster_terms || [];
                    content += `${r.product_type.padEnd(25)} | ${terms.join(', ').padEnd(35)} | ${r.status.padEnd(8)} | ${r.llm || 'Claude'}\n`;
                }
            });
            res.setHeader('Content-Disposition', `attachment; filename=${filename}.txt`);
            res.type('text/plain').send(content);
        } else if (format === 'json') {
            const jsonData = exportData.map((r, i) => {
                const syns = r.synonyms || [];
                const regs = r.regional_variations || [];
                // Algolia synonyms are a single array including the product type
                const allTerms = [...new Set([r.product_type, ...syns, ...regs])];

                return {
                    objectID: `syn-${i}`,
                    type: 'synonym',
                    synonyms: allTerms
                };
            });

            if (req.query.preview === 'true') {
                return res.json(jsonData);
            }

            res.setHeader('Content-Disposition', `attachment; filename=${filename}.json`);
            res.json(jsonData);
        } else {
            const excelRows = exportData.map(r => {
                if (shouldExpand) {
                    return {
                        'Product Type': r.product_type,
                        'Synonym/Variation': r.synonym_term,
                        'LLM': r.llm || 'Claude',
                        'Status': r.status,
                        'Source': r.source,
                        'Cluster Reference': (r.cluster_terms || []).join(', ')
                    };
                } else {
                    return {
                        'Product Type': r.product_type,
                        'Synonyms': (r.synonyms || []).join(', '),
                        'Regional Variations': (r.regional_variations || []).join(', '),
                        'Full Cluster': (r.cluster_terms || []).join(', '),
                        'LLM': r.llm || 'Claude',
                        'Status': r.status,
                        'Source': r.source,
                        'Last Updated': r.updated_at
                    };
                }
            });
            const wb = xlsx.utils.book_new();
            xlsx.utils.book_append_sheet(wb, xlsx.utils.json_to_sheet(excelRows), 'Synonyms');
            const buffer = xlsx.write(wb, { type: 'buffer', bookType: 'xlsx' });
            res.setHeader('Content-Disposition', `attachment; filename=${filename}.xlsx`);
            res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.send(buffer);
        }
    } catch (err) {
        res.status(500).send(err.message);
    }
});

if (process.env.NODE_ENV !== 'production') {
    app.listen(PORT, () => console.log(`Synonym Manager API → http://localhost:${PORT}`));
}

module.exports = app;
