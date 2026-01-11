const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const cron = require('node-cron');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS and serve static files
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// Cache for prices
let priceCache = {
    lastUpdated: null,
    goldPricePerGram: null,
    sellPrice: null,
    buyPrice: null,
    products: [],
    status: 'pending',
    error: null
};

// Product configurations
const productConfig = [
    // Minted Bars (left column)
    { id: '1g-minted', name: '1 gram', weight: 1, type: 'minted', category: 'Minted Bars' },
    { id: '5g-minted', name: '5 grams', weight: 5, type: 'minted', category: 'Minted Bars' },
    { id: '50g-minted', name: '50 grams', weight: 50, type: 'minted', category: 'Minted Bars' },
    { id: '100g-minted', name: '100 grams', weight: 100, type: 'minted', category: 'Minted Bars' },
    { id: '5g-lunar', name: '5 grams Lunar Horse', weight: 5, type: 'lunar', category: 'Minted Bars' },
    // Cast Bars (right column)
    { id: '10g-cast', name: '10 grams', weight: 10, type: 'cast', category: 'Cast Bars' },
    { id: '20g-cast', name: '20 grams', weight: 20, type: 'cast', category: 'Cast Bars' },
    { id: '50g-cast', name: '50 grams', weight: 50, type: 'cast', category: 'Cast Bars' },
    { id: '100g-cast', name: '100 grams', weight: 100, type: 'cast', category: 'Cast Bars' },
    { id: '1oz-lunar', name: '1 Ounce Lunar Horse', weight: 31.1035, type: 'lunar-oz', category: 'Cast Bars' }
];

// Premium rates (adjustable)
const premiums = {
    minted: {
        1: { percent: 0.13, fixed: 0 },
        5: { percent: 0.06, fixed: 0 },
        50: { percent: 0.01, fixed: 0 },
        100: { percent: 0.005, fixed: 0 }
    },
    cast: {
        10: { percent: 0.045, fixed: 0 },
        20: { percent: 0.025, fixed: 0 },
        50: { percent: 0.00, fixed: 0 },
        100: { percent: -0.005, fixed: 0 }
    },
    lunar: { percent: 0.065, fixed: 0 },
    'lunar-oz': { percent: 0.03, fixed: 0 }
};

// Scrape MKS PAMP pricing
async function scrapeMKSPamp() {
    console.log('[' + new Date().toISOString() + '] Starting price scrape...');

    let browser;
    try {
        browser = await puppeteer.launch({
            headless: 'new',
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        });

        const page = await browser.newPage();

        // Set user agent to avoid detection
        await page.setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

        await page.goto('https://www.mkspamp.com.my/pricing', {
            waitUntil: 'networkidle2',
            timeout: 30000
        });

        // Wait for price elements to load
        await page.waitForSelector('body', { timeout: 10000 });

        // Extract pricing data
        const prices = await page.evaluate(() => {
            const data = {
                goldSell: null,
                goldBuy: null,
                silverSell: null,
                silverBuy: null,
                products: []
            };

            // Try to find gold price per gram
            // MKS PAMP typically shows prices in a table or card format
            const allText = document.body.innerText;

            // Look for gold price patterns
            const goldMatch = allText.match(/Gold.*?(\d{2,3}(?:\.\d{2})?)\s*(?:RM|MYR)?.*?(?:per\s*gram|\/g)/i);
            if (goldMatch) {
                data.goldSell = parseFloat(goldMatch[1]);
            }

            // Try to find specific product prices
            const tables = document.querySelectorAll('table');
            tables.forEach(table => {
                const rows = table.querySelectorAll('tr');
                rows.forEach(row => {
                    const cells = row.querySelectorAll('td, th');
                    const rowText = row.innerText;

                    // Look for gold bar prices
                    if (rowText.toLowerCase().includes('gold') || rowText.toLowerCase().includes('bar')) {
                        const priceMatch = rowText.match(/RM\s*([\d,]+(?:\.\d{2})?)/);
                        if (priceMatch) {
                            data.products.push({
                                text: rowText,
                                price: parseFloat(priceMatch[1].replace(/,/g, ''))
                            });
                        }
                    }
                });
            });

            // Also try card-based layouts
            const cards = document.querySelectorAll('[class*="price"], [class*="card"], [class*="product"]');
            cards.forEach(card => {
                const text = card.innerText;
                const priceMatch = text.match(/RM\s*([\d,]+(?:\.\d{2})?)/);
                if (priceMatch && (text.toLowerCase().includes('gold') || text.toLowerCase().includes('gram'))) {
                    data.products.push({
                        text: text.substring(0, 100),
                        price: parseFloat(priceMatch[1].replace(/,/g, ''))
                    });
                }
            });

            // Try to get the base gold price from any visible element
            const priceElements = document.querySelectorAll('*');
            for (const el of priceElements) {
                const text = el.innerText || '';
                // Look for patterns like "Gold 999.9" or "Fine Gold" followed by a price
                if (text.match(/gold.*999/i) || text.match(/fine\s*gold/i)) {
                    const nearby = text.match(/(\d{3,4}(?:\.\d{2})?)\s*(?:RM|MYR|per|\/)/i);
                    if (nearby && !data.goldSell) {
                        data.goldSell = parseFloat(nearby[1]);
                    }
                }
            }

            return data;
        });

        await browser.close();

        // If we found prices, update cache
        if (prices.goldSell || prices.products.length > 0) {
            priceCache.goldPricePerGram = prices.goldSell;
            priceCache.sellPrice = prices.goldSell;
            priceCache.buyPrice = prices.goldBuy;
            priceCache.rawProducts = prices.products;
            priceCache.lastUpdated = new Date().toISOString();
            priceCache.status = 'success';
            priceCache.error = null;

            // Calculate product prices
            calculateProductPrices();

            console.log('[' + new Date().toISOString() + '] Prices updated successfully. Base price: RM ' + prices.goldSell);
        } else {
            throw new Error('Could not extract gold prices from page');
        }

    } catch (error) {
        console.error('[' + new Date().toISOString() + '] Scrape error:', error.message);
        priceCache.status = 'error';
        priceCache.error = error.message;

        if (browser) await browser.close();
    }
}

// Calculate product prices based on base gold price
function calculateProductPrices() {
    if (!priceCache.goldPricePerGram) return;

    const basePrice = priceCache.goldPricePerGram;

    priceCache.products = productConfig.map(product => {
        let premium = { percent: 0, fixed: 0 };

        if (product.type === 'minted') {
            premium = premiums.minted[product.weight] || { percent: 0.05, fixed: 0 };
        } else if (product.type === 'cast') {
            premium = premiums.cast[product.weight] || { percent: 0.02, fixed: 0 };
        } else if (product.type === 'lunar') {
            premium = premiums.lunar;
        } else if (product.type === 'lunar-oz') {
            premium = premiums['lunar-oz'];
        }

        const calculatedPrice = Math.round(basePrice * product.weight * (1 + premium.percent) + premium.fixed);

        return {
            ...product,
            price: calculatedPrice,
            priceFormatted: 'RM ' + calculatedPrice.toLocaleString()
        };
    });
}

// Manual price update endpoint (for when scraping fails)
app.post('/api/update-base-price', express.json(), (req, res) => {
    const { basePrice } = req.body;

    if (!basePrice || isNaN(basePrice)) {
        return res.status(400).json({ error: 'Invalid base price' });
    }

    priceCache.goldPricePerGram = parseFloat(basePrice);
    priceCache.lastUpdated = new Date().toISOString();
    priceCache.status = 'manual';
    priceCache.error = null;

    calculateProductPrices();

    res.json({ success: true, prices: priceCache });
});

// Update premiums endpoint
app.post('/api/update-premiums', express.json(), (req, res) => {
    const { minted, cast, lunar } = req.body;

    if (minted) Object.assign(premiums.minted, minted);
    if (cast) Object.assign(premiums.cast, cast);
    if (lunar !== undefined) premiums.lunar.percent = lunar;

    calculateProductPrices();

    res.json({ success: true, premiums, prices: priceCache });
});

// Get current prices
app.get('/api/prices', (req, res) => {
    res.json(priceCache);
});

// Force refresh prices
app.post('/api/refresh', async (req, res) => {
    await scrapeMKSPamp();
    res.json(priceCache);
});

// Health check
app.get('/api/health', (req, res) => {
    res.json({ status: 'ok', lastUpdated: priceCache.lastUpdated });
});

// Serve the main page
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Schedule price updates every 5 minutes
cron.schedule('*/5 * * * *', () => {
    console.log('Running scheduled price update...');
    scrapeMKSPamp();
});

// Start server
app.listen(PORT, async () => {
    console.log(`
╔═══════════════════════════════════════════════════════════╗
║         LITZ Gold Price Calculator Server                 ║
║                                                           ║
║  Server running at: http://localhost:${PORT}                 ║
║  API endpoints:                                           ║
║    GET  /api/prices     - Get current prices              ║
║    POST /api/refresh    - Force price refresh             ║
║    POST /api/update-base-price - Manual price update      ║
║                                                           ║
║  Prices auto-refresh every 5 minutes                      ║
╚═══════════════════════════════════════════════════════════╝
    `);

    // Initial price fetch
    await scrapeMKSPamp();
});
