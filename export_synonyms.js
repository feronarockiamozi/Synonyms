const { connectDB, Cluster } = require('./api/db');
const fs = require('fs');

async function exportToJson() {
    try {
        console.log('Connecting to database...');
        await connectDB();

        console.log('Fetching approved clusters...');
        const approvedClusters = await Cluster.find({ status: 'approved' });

        if (approvedClusters.length === 0) {
            console.log('No approved clusters found to export.');
            process.exit(0);
        }

        console.log(`Found ${approvedClusters.length} approved clusters.`);

        const { algoliasearch } = require('algoliasearch');
        const appId = process.env.ALGOLIA_APP_ID;
        const apiKey = process.env.ALGOLIA_WRITE_KEY || process.env.ALGOLIA_API_KEY;
        const PRODUCT_INDEX = process.env.ALGOLIA_INDEX_NAME || 'products-poc';
        const MATCH_THRESHOLD = 0;
        
        if (!appId || !apiKey) {
            console.error('ALGOLIA_APP_ID and ALGOLIA_API_KEY must be set to run dynamic classification export.');
            process.exit(1);
        }

        const client = algoliasearch(appId, apiKey);

        const termsArray = approvedClusters.flatMap(r => [
            r.product_type,
            ...(r.synonyms || []),
            ...(r.regional_variations || [])
        ]);
        
        const allUniqueTerms = [...new Set(termsArray)].filter(t => t && String(t).trim().length > 0);
        
        console.log(`Evaluating ${allUniqueTerms.length} unique terms against ${PRODUCT_INDEX}...`);
        
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
            process.stdout.write(`  Fetched hit counts: ${Math.min(i + SEARCH_CHUNK, allUniqueTerms.length)} / ${allUniqueTerms.length}\r`);
        }
        console.log('\nClassification complete.');

        const exportData = [];
        approvedClusters.forEach(r => {
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
                exportData.push({
                    objectID: `syn-${String(r._id)}-twoway`,
                    type: 'synonym',
                    synonyms: twoWayGroup
                });
            }

            oneWayGroup.forEach((v, idx) => {
                exportData.push({
                    objectID: `syn-${String(r._id)}-oneway-${idx}`,
                    type: 'oneWaySynonym',
                    input: v,
                    synonyms: [pt]
                });
            });
        });

        const outputPath = 'synonyms_export.json';
        fs.writeFileSync(outputPath, JSON.stringify(exportData, null, 2));

        console.log(`Successfully exported ${exportData.length} dynamic semantic rules to ${outputPath}`);
        process.exit(0);
    } catch (err) {
        console.error('Export failed:', err);
        process.exit(1);
    }
}

exportToJson();
