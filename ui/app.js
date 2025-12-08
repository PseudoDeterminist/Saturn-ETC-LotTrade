(() => {
  const ethers = window.ethers;
  const $ = (id) => document.getElementById(id);

  const exchangeAbi = [
    "function SATURN_TOKEN() view returns (address)",
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
    "function accumulatedFeesSaturn() view returns (uint256)"
  ];

  const SATURN_DECIMALS = 4;
  const SATURN_UNIT = 10n ** BigInt(SATURN_DECIMALS);

  let provider, signer, exchange, lotSize;

  const fmt = (bn, decimals = 18) => Number(ethers.formatUnits(bn, decimals)).toLocaleString();

  const requireReady = () => {
    if (!provider || !signer || !exchange) throw new Error("Connect wallet and load contract addresses first");
  };

  const parseEtc = (value, label) => {
    const trimmed = value.trim();
    if (!trimmed) throw new Error(`Enter ${label || "an ETC value"}`);
    return ethers.parseEther(trimmed);
  };

  const parseSaturnLots = (value) => {
    const trimmed = value.trim();
    if (!trimmed) throw new Error("Enter a SATURN amount");
    if (!lotSize) throw new Error("Load the contract first");
    const saturnAmount = ethers.parseUnits(trimmed, SATURN_DECIMALS);
    if (saturnAmount % lotSize !== 0n) {
      throw new Error(`Amount must be a multiple of ${ethers.formatUnits(lotSize, SATURN_DECIMALS)} SATURN (1 lot)`);
    }
    const lots = saturnAmount / lotSize;
    if (lots <= 0n) throw new Error("Amount must be at least one lot");
    return lots;
  };

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
    const netProvider = signer?.provider || provider;
    if (!netProvider) {
      alert("Connect wallet first");
      return;
    }
    const code = await netProvider.getCode(exchangeAddr);
    if (code === "0x") {
      alert("No contract code found at that address on the current network");
      return;
    }
    exchange = new ethers.Contract(exchangeAddr, exchangeAbi, signer || netProvider);
    // Cache lot size for SATURN parsing
    lotSize = await exchange.LOT_SIZE();

    // If SATURN address not set, try reading from contract
    if (!$("saturnAddress").value) {
      const saturn = await exchange.SATURN_TOKEN();
      $("saturnAddress").value = saturn;
    }
    await refreshAll();
  }

  async function refreshAll() {
    try {
      requireReady();
      const acct = await signer.getAddress();
      const [acc, orders, ob] = await Promise.all([
        exchange.accounts(acct),
        exchange.getUserOrders(acct),
        exchange.getOrderBook()
      ]);

      $("balances").textContent =
        `you: SATURN=${ethers.formatUnits(acc.tokenBalance, SATURN_DECIMALS)} | ETC=${ethers.formatEther(acc.etherBalance)}\n` +
        `orders: ${orders.length ? orders.join(", ") : "none"}`;

      const [buyIds, buyPrices, buyLots, sellIds, sellPrices, sellLots] = ob;

      const render = (ids, prices, lots) => ids.map((id, i) => {
        const etc = ethers.formatEther(prices[i]);
        let saturnLots = lots[i].toString();
        if (lotSize) {
          const saturn = ethers.formatUnits(BigInt(lots[i]) * lotSize, SATURN_DECIMALS);
          saturnLots = `${saturn} SATURN`;
        } else {
          saturnLots = `${saturnLots} lots`;
        }
        return `#${id} @ ${etc} ETC (${saturnLots})`;
      }).join("\n") || "—";

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
      const value = parseEtc($("depositEtc").value, "an ETC amount");
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
      const price = parseEtc($("price").value, "a price per SATURN lot");
      const lots = parseSaturnLots($("lots").value);
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
      const price = parseEtc($("immediatePrice").value, "a price per SATURN lot");
      const lots = parseSaturnLots($("immediateLots").value);
      const value = parseEtc($("immediateValue").value, "a msg.value");
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
    $("saturnAddress").value = window.localStorage.getItem("saturnToken") || "";
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
  $("saturnAddress").addEventListener("blur", () => {
    const v = $("saturnAddress").value.trim();
    if (ethers.isAddress(v)) window.localStorage.setItem("saturnToken", v);
  });
})();
