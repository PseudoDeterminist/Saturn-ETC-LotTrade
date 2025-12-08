(() => {
  const ethers = window.ethers;
  const $ = (id) => document.getElementById(id);

  const exchangeAbi = [
    "function STRN_TOKEN() view returns (address)",
    "function LOT_SIZE() view returns (uint256)",
    "function accounts(address) view returns (uint256 tokenBalance, uint256 etherBalance)",
    "function getUserOrders(address) view returns (uint64[] memory)",
    "function getOrderBook() view returns (uint64[],uint128[],uint128[],uint64[],uint128[],uint128[])",
    "function depositEtc() payable",
    "function placeLimitBuyFromBalance(uint128 pricePerLot, uint128 lots)",
    "function placeLimitSellFromBalance(uint128 pricePerLot, uint128 lots)",
    "function placeLimitBuyImmediate(uint128 pricePerLot, uint128 lotsMax) payable",
    "function cancelOrder(uint64 orderId)",
    "function cancelAllMyOrders()",
    "function withdrawAll()",
    "function accumulatedFeesEtc() view returns (uint256)",
    "function accumulatedFeesStrn() view returns (uint256)"
  ];

  let provider, signer, exchange;

  const fmt = (bn, decimals = 18) => Number(ethers.formatUnits(bn, decimals)).toLocaleString();

  function requireReady() {
    if (!provider || !signer || !exchange) throw new Error("Connect wallet and load contract addresses first");
  }

  async function connect() {
    if (!window.ethereum) {
      alert("No injected wallet found");
      return;
    }
    await window.ethereum.request({ method: "eth_requestAccounts" });
    provider = new ethers.BrowserProvider(window.ethereum);
    signer = await provider.getSigner();
    await loadContracts();
  }

  async function loadContracts() {
    const exchangeAddr = $("exchangeAddress").value.trim();
    if (!ethers.isAddress(exchangeAddr)) {
      alert("Enter a valid exchange address");
      return;
    }
    exchange = new ethers.Contract(exchangeAddr, exchangeAbi, signer || provider);
    // If STRN address not set, try reading from contract
    if (!$("strnAddress").value) {
      const strn = await exchange.STRN_TOKEN();
      $("strnAddress").value = strn;
    }
    await refreshAll();
  }

  async function refreshAll() {
    try {
      requireReady();
      const acct = signer.address;
      const [acc, orders, ob] = await Promise.all([
        exchange.accounts(acct),
        exchange.getUserOrders(acct),
        exchange.getOrderBook()
      ]);

      $("balances").textContent =
        `you: STRN=${acc.tokenBalance} | ETC=${ethers.formatEther(acc.etherBalance)}\n` +
        `orders: ${orders.length ? orders.join(", ") : "none"}`;

      const [buyIds, buyPrices, buyLots, sellIds, sellPrices, sellLots] = ob;

      const render = (ids, prices, lots) => ids.map((id, i) =>
        `#${id} @ ${prices[i].toString()} wei (${lots[i].toString()} lots)`
      ).join("\n") || "—";

      $("buyBook").textContent = render(buyIds, buyPrices, buyLots);
      $("sellBook").textContent = render(sellIds, sellPrices, sellLots);
    } catch (err) {
      console.error(err);
      alert(err.message || err);
    }
  }

  async function depositEtc() {
    try {
      requireReady();
      const value = $("depositEtc").value;
      const tx = await exchange.depositEtc({ value });
      await tx.wait();
      await refreshAll();
    } catch (err) {
      console.error(err);
      alert(err.message || err);
    }
  }

  async function place() {
    try {
      requireReady();
      const side = $("side").value;
      const price = $("price").value;
      const lots = $("lots").value;
      if (!price || !lots) return alert("Enter price and lots");
      const fn = side === "buy" ? "placeLimitBuyFromBalance" : "placeLimitSellFromBalance";
      const tx = await exchange[fn](price, lots);
      await tx.wait();
      await refreshAll();
    } catch (err) {
      console.error(err);
      alert(err.message || err);
    }
  }

  async function buyImmediate() {
    try {
      requireReady();
      const price = $("immediatePrice").value;
      const lots = $("immediateLots").value;
      const value = $("immediateValue").value;
      if (!price || !lots || !value) return alert("Enter price, lots, and msg.value");
      const tx = await exchange.placeLimitBuyImmediate(price, lots, { value });
      await tx.wait();
      await refreshAll();
    } catch (err) {
      console.error(err);
      alert(err.message || err);
    }
  }

  async function cancel() {
    try {
      requireReady();
      const id = $("cancelId").value;
      if (!id) return alert("Enter order id");
      const tx = await exchange.cancelOrder(id);
      await tx.wait();
      await refreshAll();
    } catch (err) {
      console.error(err);
      alert(err.message || err);
    }
  }

  async function cancelAll() {
    try {
      requireReady();
      const tx = await exchange.cancelAllMyOrders();
      await tx.wait();
      await refreshAll();
    } catch (err) {
      console.error(err);
      alert(err.message || err);
    }
  }

  async function withdrawAll() {
    try {
      requireReady();
      const tx = await exchange.withdrawAll();
      await tx.wait();
      await refreshAll();
    } catch (err) {
      console.error(err);
      alert(err.message || err);
    }
  }

  // Wire UI
  $("connect").onclick = connect;
  $("loadDefault").onclick = () => {
    $("exchangeAddress").value = window.localStorage.getItem("saturnExchange") || "";
    $("strnAddress").value = window.localStorage.getItem("saturnStrn") || "";
  };
  $("refresh").onclick = refreshAll;
  $("refreshOrderbook").onclick = refreshAll;
  $("depositEtcBtn").onclick = depositEtc;
  $("place").onclick = place;
  $("buyImmediate").onclick = buyImmediate;
  $("cancel").onclick = cancel;
  $("cancelAll").onclick = cancelAll;
  $("withdrawAll").onclick = withdrawAll;

  // Persist address fields on blur
  $("exchangeAddress").addEventListener("blur", () => {
    const v = $("exchangeAddress").value.trim();
    if (ethers.isAddress(v)) window.localStorage.setItem("saturnExchange", v);
  });
  $("strnAddress").addEventListener("blur", () => {
    const v = $("strnAddress").value.trim();
    if (ethers.isAddress(v)) window.localStorage.setItem("saturnStrn", v);
  });
})();
