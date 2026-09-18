const API_URL = "http://127.0.0.1:8787/api/admin/deposits";
const ADMIN_SECRET = "admin123";

async function approveAll() {
    try {
        const res = await fetch(`${API_URL}/pending`, {
            headers: { "x-admin-secret": ADMIN_SECRET }
        });
        const data = await res.json();

        if (!data.deposits || data.deposits.length === 0) {
            console.log("No pending deposits found.");
            return;
        }

        console.log(`Found ${data.deposits.length} pending deposit(s). Approving...`);

        for (const dep of data.deposits) {
            const resp = await fetch(`${API_URL}/${dep.id}/approve`, {
                method: "POST",
                headers: { "x-admin-secret": ADMIN_SECRET, "Content-Type": "application/json" },
                body: JSON.stringify({ note: "Approved via admin script" })
            });
            const result = await resp.json();
            if (result.ok) {
                console.log(`✅ Approved deposit ${dep.id} for ${result.amount} ETB`);
            } else {
                console.log(`❌ Failed to approve ${dep.id}:`, result.error);
            }
        }
    } catch (err) {
        console.error("Error approving deposits:", err);
    }
}

approveAll();
