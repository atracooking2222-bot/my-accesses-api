const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');
const path = require('path');

const app = express();
app.use(express.json());
app.use(cors());

// 🔗 ភ្ជាប់ទៅកាន់ PostgreSQL Database (Neon)
const pool = new Pool({
    connectionString: 'postgresql://neondb_owner:npg_gqyNjVpn0a9A@ep-summer-mountain-b5v7mdk3-pooler.c-7.us-east-2.aws.neon.tech/neondb?sslmode=require',
});

pool.connect()
    .then(() => console.log("Connected to PostgreSQL (Neon) Database successfully!"))
    .catch(err => console.error("Database connection error:", err));

// ----------------- 0. SERVE FRONTEND STATIC FILES -----------------
app.use(express.static(path.join(__dirname)));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// ----------------- 1. CREATE TABLES & MIGRATE COLUMNS -----------------
const initTables = async () => {
    const queryMaster = `
        CREATE TABLE IF NOT EXISTS master_items (
            id SERIAL PRIMARY KEY,
            type VARCHAR(50) DEFAULT 'EXPENSE',
            category VARCHAR(255) NOT NULL,
            item_name VARCHAR(255) NOT NULL,
            stock_quantity INT DEFAULT 0,
            cost_price DECIMAL(10, 2) DEFAULT 0
        );
    `;
    const queryTransactions = `
        CREATE TABLE IF NOT EXISTS transactions (
            id SERIAL PRIMARY KEY,
            date TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            type VARCHAR(50) NOT NULL,
            item_id INT,
            category VARCHAR(255) NOT NULL,
            item_name VARCHAR(255) NOT NULL,
            quantity INT NOT NULL DEFAULT 1,
            unit_price DECIMAL(10, 2) NOT NULL,
            amount DECIMAL(10, 2) NOT NULL
        );
    `;
    try {
        await pool.query(queryMaster);
        await pool.query(queryTransactions);
        
        await pool.query(`ALTER TABLE master_items ADD COLUMN IF NOT EXISTS type VARCHAR(50) DEFAULT 'EXPENSE';`);
        await pool.query(`ALTER TABLE master_items ALTER COLUMN type DROP NOT NULL;`);
        await pool.query(`ALTER TABLE master_items ALTER COLUMN type SET DEFAULT 'EXPENSE';`);

        await pool.query(`ALTER TABLE master_items ADD COLUMN IF NOT EXISTS stock_quantity INT DEFAULT 0;`);
        await pool.query(`ALTER TABLE master_items ADD COLUMN IF NOT EXISTS cost_price DECIMAL(10, 2) DEFAULT 0;`);
        await pool.query(`ALTER TABLE transactions ADD COLUMN IF NOT EXISTS item_id INT;`);

        console.log("Database tables and columns are ready and safe.");
    } catch (err) {
        console.error("Error creating/updating tables:", err);
    }
};
initTables();

// ----------------- 2. MASTER ITEMS API -----------------

app.get('/api/accounting/master-items', async (req, res) => {
    try {
        let result = await pool.query('SELECT * FROM master_items ORDER BY category, item_name ASC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/accounting/master-items', async (req, res) => {
    try {
        let { type, category, item_name, stock_quantity, cost_price } = req.body;
        const formattedType = (type && type.trim() !== '') ? type.toUpperCase() : 'EXPENSE';

        const query = `
            INSERT INTO master_items (type, category, item_name, stock_quantity, cost_price)
            VALUES ($1, $2, $3, $4, $5) RETURNING *;
        `;
        let result = await pool.query(query, [
            formattedType, 
            category, 
            item_name, 
            stock_quantity || 0, 
            cost_price || 0
        ]);
        
        res.status(201).json({ success: true, message: "Master item added successfully!", data: result.rows[0] });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

// 👉 API កែសម្រួល Master Item (PUT)
app.put('/api/accounting/master-items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { category, item_name, stock_quantity, cost_price } = req.body;

        const query = `
            UPDATE master_items 
            SET category = $1, item_name = $2, stock_quantity = $3, cost_price = $4
            WHERE id = $5 RETURNING *;
        `;
        let result = await pool.query(query, [
            category, 
            item_name, 
            stock_quantity || 0, 
            cost_price || 0, 
            id
        ]);

        if (result.rows.length === 0) {
            return res.status(404).json({ success: false, error: "Master item not found!" });
        }

        res.json({ success: true, message: "Master item updated successfully!", data: result.rows[0] });
    } catch (err) {
        res.status(400).json({ success: false, error: err.message });
    }
});

app.delete('/api/accounting/master-items/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM master_items WHERE id = $1', [id]);
        res.json({ success: true, message: "Master item deleted successfully!" });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

// ----------------- 3. TRANSACTIONS API -----------------

app.get('/api/accounting/transactions', async (req, res) => {
    try {
        let result = await pool.query('SELECT * FROM transactions ORDER BY date DESC');
        res.json({ success: true, data: result.rows });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.post('/api/accounting/transactions', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');

        const { type, item_id, category, item_name, quantity, unit_price } = req.body;
        const formattedType = type ? type.toUpperCase() : 'INCOME';
        const qty = parseInt(quantity) || 1;
        const price = parseFloat(unit_price) || 0;
        const totalAmount = qty * price;

        // 1. បញ្ចូលទិន្នន័យទៅក្នុងតារាង transactions
        const insertQuery = `
            INSERT INTO transactions (type, item_id, category, item_name, quantity, unit_price, amount)
            VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *;
        `;
        let result = await client.query(insertQuery, [formattedType, item_id, category, item_name, qty, price, totalAmount]);

        // 2. កែសម្រួលស្តុក និងគណនាតម្លៃមធ្យមភាគ (Weighted Average Cost)
        if (item_id) {
            if (formattedType === 'INCOME') {
                await client.query(`UPDATE master_items SET stock_quantity = stock_quantity - $1 WHERE id = $2`, [qty, item_id]);
            } else if (formattedType === 'EXPENSE') {
                let masterRes = await client.query(`SELECT stock_quantity, cost_price FROM master_items WHERE id = $1`, [item_id]);
                
                if (masterRes.rows.length > 0) {
                    let item = masterRes.rows[0];
                    let oldStock = parseInt(item.stock_quantity) || 0;
                    let oldCostPrice = parseFloat(item.cost_price) || 0;
                    
                    let newStock = oldStock + qty;
                    let newCostPrice = oldCostPrice;

                    if (newStock > 0) {
                        newCostPrice = ((oldStock * oldCostPrice) + (qty * price)) / newStock;
                    }

                    await client.query(
                        `UPDATE master_items SET stock_quantity = $1, cost_price = $2 WHERE id = $3`,
                        [newStock, newCostPrice, item_id]
                    );
                }
            }
        }

        await client.query('COMMIT');
        res.status(201).json({ success: true, data: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// 👉 API កែសម្រួល Transaction (PUT)
app.put('/api/accounting/transactions/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;
        const { type, item_id, quantity, unit_price } = req.body;
        
        const qty = parseInt(quantity) || 1;
        const price = parseFloat(unit_price) || 0;
        const totalAmount = qty * price;
        const formattedType = type ? type.toUpperCase() : 'INCOME';

        let oldTxData = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
        if (oldTxData.rows.length === 0) {
            await client.query('ROLLBACK');
            return res.status(404).json({ success: false, error: "Transaction not found!" });
        }
        let oldTx = oldTxData.rows[0];

        // 1. ធ្វើបច្ចុប្បន្នភាពស្តុកក្នុង master_items វិញជាមុនសិន (Reverse old stock change)
        if (oldTx.item_id) {
            if (oldTx.type === 'INCOME') {
                await client.query(`UPDATE master_items SET stock_quantity = stock_quantity + $1 WHERE id = $2`, [oldTx.quantity, oldTx.item_id]);
            } else if (oldTx.type === 'EXPENSE') {
                await client.query(`UPDATE master_items SET stock_quantity = stock_quantity - $1 WHERE id = $2`, [oldTx.quantity, oldTx.item_id]);
            }
        }

        // 2. កាត់/បន្ថែមស្តុកថ្មី
        if (item_id) {
            if (formattedType === 'INCOME') {
                await client.query(`UPDATE master_items SET stock_quantity = stock_quantity - $1 WHERE id = $2`, [qty, item_id]);
            } else if (formattedType === 'EXPENSE') {
                await client.query(`UPDATE master_items SET stock_quantity = stock_quantity + $1 WHERE id = $2`, [qty, item_id]);
            }
        }

        // 3. ធ្វើបច្ចុប្បន្នភាពតារាង transactions
        const updateQuery = `
            UPDATE transactions 
            SET type = $1, item_id = $2, quantity = $3, unit_price = $4, amount = $5
            WHERE id = $6 RETURNING *;
        `;
        let result = await client.query(updateQuery, [formattedType, item_id, qty, price, totalAmount, id]);

        await client.query('COMMIT');
        res.json({ success: true, message: "Transaction updated successfully!", data: result.rows[0] });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(400).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

app.get('/api/accounting/summary', async (req, res) => {
    try {
        let txResult = await pool.query("SELECT * FROM transactions WHERE type = 'INCOME'");
        let masterResult = await pool.query("SELECT * FROM master_items");
        
        let totalIncome = 0;
        let totalProfit = 0;

        let costPriceMap = {};
        masterResult.rows.forEach(m => {
            costPriceMap[m.id] = parseFloat(m.cost_price) || 0;
        });

        txResult.rows.forEach(tx => {
            let incomeAmt = parseFloat(tx.amount) || 0;
            totalIncome += incomeAmt;

            let costPrice = costPriceMap[tx.item_id] || 0;
            let profitPerUnit = parseFloat(tx.unit_price) - costPrice;
            totalProfit += (profitPerUnit * tx.quantity);
        });

        let totalInventoryValue = 0;
        masterResult.rows.forEach(m => {
            totalInventoryValue += (parseInt(m.stock_quantity) * parseFloat(m.cost_price));
        });

        res.json({
            success: true,
            summary: {
                total_income: totalIncome,
                total_purchase_value: totalInventoryValue,
                net_profit: totalProfit
            }
        });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.get('/api/accounting/category-summary', async (req, res) => {
    try {
        let masterResult = await pool.query("SELECT * FROM master_items");
        let txResult = await pool.query("SELECT * FROM transactions WHERE type = 'INCOME'");

        let categoryProfitMap = {};
        masterResult.rows.forEach(m => {
            if (!categoryProfitMap[m.category]) categoryProfitMap[m.category] = 0;
        });

        txResult.rows.forEach(tx => {
            let masterItem = masterResult.rows.find(m => m.id === tx.item_id);
            let costPrice = masterItem ? parseFloat(masterItem.cost_price) : 0;
            let profit = (parseFloat(tx.unit_price) - costPrice) * tx.quantity;

            if (!categoryProfitMap[tx.category]) categoryProfitMap[tx.category] = 0;
            categoryProfitMap[tx.category] += profit;
        });

        let formattedData = Object.keys(categoryProfitMap).map(cat => ({
            category: cat,
            profit: categoryProfitMap[cat]
        }));

        res.json({ success: true, data: formattedData });
    } catch (err) {
        res.status(500).json({ success: false, error: err.message });
    }
});

app.delete('/api/accounting/transactions/:id', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        const { id } = req.params;

        let txData = await client.query('SELECT * FROM transactions WHERE id = $1', [id]);
        if (txData.rows.length > 0) {
            let tx = txData.rows[0];
            if (tx.item_id) {
                if (tx.type === 'INCOME') {
                    await client.query(`UPDATE master_items SET stock_quantity = stock_quantity + $1 WHERE id = $2`, [tx.quantity, tx.item_id]);
                } else if (tx.type === 'EXPENSE') {
                    await client.query(`UPDATE master_items SET stock_quantity = stock_quantity - $1 WHERE id = $2`, [tx.quantity, tx.item_id]);
                }
            }
            await client.query('DELETE FROM transactions WHERE id = $1', [id]);
        }

        await client.query('COMMIT');
        res.json({ success: true, message: "Transaction deleted successfully!" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// 👉 API សម្រាប់ Clear / Reset ទិន្នន័យទាំងអស់ចោល
app.post('/api/accounting/reset-all', async (req, res) => {
    const client = await pool.connect();
    try {
        await client.query('BEGIN');
        await client.query('DELETE FROM transactions;');
        await client.query('DELETE FROM master_items;');
        await client.query('COMMIT');
        res.json({ success: true, message: "All data cleared successfully from database!" });
    } catch (err) {
        await client.query('ROLLBACK');
        res.status(500).json({ success: false, error: err.message });
    } finally {
        client.release();
    }
});

// រត់ Server
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Accounting API Server is running on port ${PORT}`);
});
