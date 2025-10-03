//import readline from 'readline-sync';
import * as readline from 'readline/promises';
import { stdin as input, stdout as output } from 'node:process';

import yahooFinance from 'yahoo-finance2';
//import { IB, EventName } from 'ib';
import { IBApi, EventName, ErrorCode, Contract, OrderState } from '@stoqey/ib';


interface Symbol {
  symbol: string;
  orderId: number;
  pos: number;
  buyPrice: number;
  sellPrice: number;
  tobuy: boolean;
  tosell: boolean;
  marketprice: number;
  tracking: boolean;
  contract: Contract1;
  buyingPower: number;
}


export interface Order {
  orderId: number,
  conId: number,
  symbol: string,
  action: string,
  pos: number,
  buyPrice: number,
  sellPrice: number,
  orderType: string,
  tif: string,
  status: string,
  transmit: boolean,
  cancelled: boolean
}

export interface Orders {
  [symbol: string]: Order
}

export interface Symbols {
  [symbol: string]: Symbol
}

export interface Contract1 {
  symbol: string,
  secType: string,
  currency: string,
  exchange: string,
  conId: string,
  pos: number,
  handler: number
}


export class TradingBot {

  private ib;
  private marginMultiplier: number;
  private port: number;
  //  private buyingPower: number = 0;
  private initialinvestment = 0;


  //  private contracts={} as Contracts;
  private orders = {} as Orders;
  private symbols = {} as Symbols;

  private ibkraccount;

  //  private openprice = 0;

  private symbol: string;
  private rateh = 0.1;
  private ratel = 0.1;
  private nextOrderId: number = 0;


  private eventQueue: (() => Promise<void>)[] = [];
  private isProcessing = false;

  //  private currentOrder: Order;

  private index = 1001;

  private lastBuyPriceUpdate: { [symbol: string]: number } = {};

  constructor() {
    this.main();
  }

  private async main() {
    try {
      await this.collectInputs();
    } catch (e) {
      console.log('error collectInputs=', e);
    }

    try {
      await this.connect();
    } catch (e) {
      console.log('error connect=', e);
    }

    try {
      await this.getActiveOrders();
    } catch (e) {
      console.log('error getActiveOrders=', e);
    }

    try {
      await this.getAvailableFunds();
    } catch (e) {
      console.log('error getAvailableFunds=', e);
    }

    try {
      await this.getPositions();
    } catch (e) {
      console.log('error getPositions=', e);
    }

    this.setupSequentialHandlers();
  }

  private async collectInputs() {
    const rl = readline.createInterface({ input, output });
    this.initialinvestment = parseInt(await rl.question('Enter the investment: '));
    this.initialinvestment = this.initialinvestment ? this.initialinvestment : 0;

    let openprice = 0
    if (this.initialinvestment > 0) {
      let symbol1 = await rl.question('Enter stock symbol (e.g., AAPL): ');
      this.symbol = symbol1.toUpperCase();
      let quote;
      try {
        quote = await yahooFinance.quote(this.symbol);
        openprice = quote.regularMarketOpen;
      } catch (error) {
        console.error('Error fetching opening price:', error);
      }
      let cont = {
        symbol: this.symbol,
        secType: 'STK',
        currency: 'USD',
        exchange: 'SMART',
        handler: 1000
      } as Contract1;

      this.symbols[this.symbol] = {
        symbol: this.symbol,
        orderId: null,
        pos: 0,
        tobuy: true,
        tosell: false,
        tracking: false,
        contract: cont,
        buyingPower: this.initialinvestment
      } as Symbol;

    }

    this.marginMultiplier = 1;

    //    this.openprice = openprice;

    this.ratel = Number(await rl.question('Enter the rate low: '));
    this.ratel = this.ratel === 0 ? 0.1 : Math.max(Number(this.ratel), 0.1);


    this.rateh = Number(await rl.question('Enter the rate high: '));
    this.rateh = this.rateh === 0 ? 0 : Math.max(Number(this.rateh), 0);

    let account = await rl.question('Enter the account (A/P/S): ');

    switch (account.toUpperCase()) {
      case 'P':
        this.ibkraccount = 'U7648331';
        this.port = 7496;
        break;
      case 'A':
        this.ibkraccount = 'U7914923';
        this.port = 7496;
        break;
      case 'S':
        this.ibkraccount = 'DUH673915';
        this.port = 7497;
        break;
      default:
        this.ibkraccount = 'DUH673915';
        this.port = 7497;
        break;
    }
  }

  private async connect(): Promise<void> {
    this.ib = new IBApi({
      host: '127.0.0.1',
      port: this.port,
      clientId: 1
    });

    this.ib
      .on(EventName.error, (err: Error, code: ErrorCode, reqId: number) => {
        console.error(`❌ Error ${err.message} - code: ${code} - reqId: ${reqId}`);
      })

    try {
      await this.ib.connect();
    } catch (err) {
      console.error('❌ Connection Error:', err);
    }
    console.log('Connection success');
/*    const positions = await this.getPositions1();
    console.log('Positions:', positions);

    const openOrders = await this.getOpenOrders();
    console.log('Open Orders:', openOrders);*/
  }


  private async getAvailableFunds(): Promise<void> {
    if (this.initialinvestment > 0) {
      if (this.symbols && this.symbols[this.symbol] && this.symbols[this.symbol].contract) {
        this.ib.reqMktData(1000, this.symbols[this.symbol].contract, '', false, false); // Get bid price
      }
    }

    // ✅ Request Account Summary
    if (this.initialinvestment === 0) {
      this.ib.reqAccountSummary(1, 'All', 'AvailableFunds');
    }
  }

  private async getPositions(): Promise<void> {
    await this.ib.reqPositions();
    let i = 1001;
  }


  private getActiveOrders() {
    this.ib.reqOpenOrders(); // or this.ib.reqAllOpenOrders();
  }

  private async enqueue(handler: () => Promise<void>): Promise<void> {
    this.eventQueue.push(handler);
    if (!this.isProcessing) {
      this.isProcessing = true;
      while (this.eventQueue.length > 0) {
        const fn = this.eventQueue.shift();
        if (fn) {
          try {
            await fn();
          } catch (err) {
            console.error('Handler error:', err);
          }
        }
      }
      this.isProcessing = false;
    }
  }

  private setupSequentialHandlers(): void {
    const allEvents: { [K in keyof typeof EventName]?: (...args: any[]) => Promise<void> } = {
      tickPrice: async (...args: [number, number, number]) => await this.onTickPrice(...args),
      orderStatus: async (...args: any[]) => await this.onOrderStatus(...args as [number, string, number, number, number]),
      openOrder: async (...args: any[]) => await this.onOpenOrder(...args as [number, any, any, string]),
      nextValidId: async (...args: any[]) => await this.onNextValidId(...args as [number]),
      position: async (...args: any[]) => await this.onPosition(...args as [any, any, any, any]),
      pnlSingle: async (...args: any[]) => {
        await this.onPnL(...args as [number, number, number, number, number, number])
      }
    };

    for (const [eventName, handler] of Object.entries(allEvents)) {
      if (handler) {
        this.ib.on(eventName as keyof typeof EventName, (...args: any[]) => {

          handler(...args)
        }
        );
      }

    }
  }


  private lastBuyOrderTime: { [symbol: string]: number } = {};

  private onTickPrice(tickerId: number, field: number, price2: number): Promise<void> {
    return new Promise(async (resolve) => {
      const symbolEntry = Object.values(this.symbols).find(c => c.contract && c.contract.handler === tickerId);
      if (!symbolEntry) return;

      const symbol = symbolEntry.symbol;
      const sym = this.symbols[symbol];

      if ((field === 1 || field === 4) && price2 > 0) {
        const now = Date.now();
        const lastTime = this.lastBuyOrderTime[symbol] || 0;

        // Adjust price only if not bid (field 1)
        sym.buyPrice = Math.round(price2 * (1 - this.ratel / 100) * 100) / 100;

        // Only act if it's the first buy or enough time has passed
        //      if (sym.tobuy || ((now - lastTime >= 60000)) && this.orders[symbol] && this.orders[symbol].action === 'BUY') {
        if (sym.tobuy) {
          sym.tobuy = false;
          this.lastBuyOrderTime[symbol] = now;

          // Optional: cancel previous order if needed before placing new one
          if (this.orders[symbol]?.orderId) {
            await this.ib.cancelOrder(this.orders[symbol].orderId);
          }

          await this.placeBuyOrder(symbol);
        }
      }
      resolve();
    });
  }

  // Define other handlers similarly
  private onOrderStatus(orderId, status, filled, remaining, avgFillPrice): Promise<void> {
    return new Promise(async (resolve) => {
      if (status === 'Filled' && filled > 0 && remaining === 0) {
        const order = Object.values(this.orders).find(o => o.orderId === orderId);
        if (order && orderId === order.orderId && status === 'Filled' && filled > 0 && remaining === 0) {
          if (this.orders[order.symbol]) {
            delete this.orders[order.symbol];
          }
          const contract = this.symbols[order.symbol]?.contract;
          const sym = this.symbols[order.symbol];
          sym.pos = filled;
          if (order.action === 'SELL') {
            sym.tobuy = true;
            sym.tosell = false;
            sym.sellPrice = avgFillPrice;
            sym.buyingPower = avgFillPrice * filled;
          } else {
            sym.tobuy = false;
            sym.tosell = true;
            sym.buyPrice = avgFillPrice;
            sym.buyingPower = avgFillPrice * filled;
            if (contract && contract.handler) {
              //              await this.ib.cancelPnLSingle(contract.handler);
              //              await this.ib.reqPnLSingle(contract.handler, this.ibkraccount, "", contract.conId);
              //              await this.ib.cancelMktData(contract.handler);
              //              await this.ib.reqMktData(contract.handler, this.symbols[order.symbol].contract, '', false, false); // Get bid price
            }
          }
        }

      } else {
        const order = Object.values(this.orders).find(o => o.orderId === orderId);
        if (order && orderId === order.orderId && status === 'Cancelled') {
          const contract = this.symbols[order.symbol]?.contract;
          const sym = this.symbols[order.symbol];
          if (order.action === 'SELL') {
            sym.tobuy = false;
            sym.tosell = true;
          } else {
            sym.tobuy = true;
            sym.tosell = false;
          }
          if (contract && contract.handler) {
                        await this.ib.cancelPnLSingle(contract.handler);
                        await this.ib.reqPnLSingle(contract.handler, this.ibkraccount, "", contract.conId);
                        await this.ib.cancelMktData(contract.handler);
                        await this.ib.reqMktData(contract.handler, this.symbols[order.symbol].contract, '', false, false); // Get bid price
          }
          if (this.orders[order.symbol]) {
            delete this.orders[order.symbol];
          }
        }
      }
      resolve();
    });
  }

  private onOpenOrder(orderId, contract, order, orderState): Promise<void> {
    return new Promise(async (resolve) => {
      const key = `${contract.symbol}_${order.action}_${order.totalQuantity}_${order.lmtPrice}`;
      if (!(this.orders && this.orders[contract.symbol])) {
        this.orders[contract.symbol] = {
          orderId: orderId,
          action: order.action,
          pos: order.totalQuantity,
          orderType: 'LMT',
          buyPrice: order.lmtPrice,
          sellPrice: order.lmtPrice,
          tif: 'DAY',
          transmit: false,
          symbol: contract.symbol,
          conId: contract.conId,
          cancelled: false
        } as Order;
        try {
          this.orders[contract.symbol].cancelled = true;
          await this.ib.cancelOrder(order.orderId);
        } catch (e) {
          console.log(`📌 Error cancelling Order: ${order.action} ${order.totalQuantity} ${contract.symbol} @ $${order.lmtPrice}`, ', error=', e);
        }
      }
      resolve();
    });
  }

  private async onNextValidId(orderId): Promise<void> {
    this.nextOrderId = orderId;
  }

  private onPosition(account, contract, pos, avgCost?): Promise<void> {
    return new Promise(async (resolve) => {

      if (pos > 0) {
        if (this.symbol && this.symbols && contract.symbol.toUpperCase() === this.symbol.toUpperCase() && !this.symbols[contract.symbol].tracking) {
          this.ib.reqPnLSingle(1000, this.ibkraccount, "", contract.conId);
          this.symbols[contract.symbol].tracking = true;
        } else if (this.symbols && (!this.symbols[contract.symbol] || (this.symbols[contract.symbol] && !this.symbols[contract.symbol].tracking))) {
          if (this.symbols[contract.symbol] === undefined) {
            let cont = {
              symbol: contract.symbol,
              secType: 'STK',
              currency: 'USD',
              exchange: 'SMART',
              conId: contract.conId,
              pos: pos,
              handler: this.index
            } as Contract1;
            this.symbols[contract.symbol] = {} as Symbol;
            this.symbols[contract.symbol].tobuy = false;
            this.symbols[contract.symbol].tosell = true;
            this.symbols[contract.symbol].contract = cont;
            this.symbols[contract.symbol].buyPrice = avgCost;
            this.symbols[contract.symbol].pos = pos;
            this.symbols[contract.symbol].symbol = contract.symbol;
            this.symbols[contract.symbol].tracking = true;
            this.ib.reqPnLSingle(this.index, this.ibkraccount, "", contract.conId);
            this.ib.reqMktData(this.index, cont, '', false, false); // Get bid price
            this.index++;
          }
        }
      }
      resolve();
    });

  }

  private onPnL(i, pos, dailyPnL, unrealizedPnL, realizedPnL, value): Promise<void> {
    return new Promise(async (resolve) => {
      const symbolEntry = Object.values(this.symbols).find(c => c.contract && c.contract.handler === i);
      if (!symbolEntry || pos === 0) {
        return;
      } else {
        const symbol = symbolEntry.symbol;
        if (!this.symbols[symbol]) this.symbols[symbol] = {} as Symbol;

        this.symbols[symbol].pos = pos;
        this.symbols[symbol].symbol = symbol;

        const profit = (value - unrealizedPnL) * ((this.ratel / 100 + this.rateh / 100));
        const buyPrice = Math.round((value - unrealizedPnL) / pos * 100) / 100;
        const sellPrice = Math.round(((value - unrealizedPnL) + profit) / pos * 100) / 100;
        if (this.symbols[symbol].buyPrice === undefined) {
          this.symbols[symbol].buyPrice = buyPrice;
        }
        console.log('0 symbol=', symbol, ', pos=', pos, ', value=', value, ', unrealisedPL=', unrealizedPnL, ', profit=', profit, "sym.tosell=", this.symbols[symbol].tosell, "sym.tobuy=", this.symbols[symbol].tobuy);
        if (this.symbols[symbol].tosell) {
          this.symbols[symbol].tosell = false;
          for (const key in this.orders) {
            const order = this.orders[key];
            if (order.symbol === symbol && order.action === 'SELL' && order.cancelled === false) {
              try {
                order.cancelled = true;
                await this.ib.cancelOrder(order.orderId);
                delete this.orders[key];
              } catch (e) {
                console.log('erreur cancelling order %d=', this.orders[key].orderId, e)
              }
            }
          }
          await this.placeSellOrder(symbol, sellPrice, pos);
        }
      }
      resolve();
    });
  }

  private async placeBuyOrder(symbol: string): Promise<void> {
    const contract = {
      symbol: symbol,
      secType: 'STK',
      currency: 'USD',
      exchange: 'SMART',
    };

    this.symbols[symbol].pos = Math.floor(this.symbols[symbol].buyingPower / this.symbols[symbol].buyPrice);
    console.log(`🟢 Placing BUY order: ${this.symbols[symbol].pos} shares of ${symbol} at Bid Price $${this.symbols[symbol].buyPrice}`);
    if (this.symbols[symbol].pos > 0) {
      this.symbols[symbol].tobuy = false;
      try {
        const orderId = this.nextOrderId++;
        this.orders[symbol] = {
          orderId: orderId,
          action: 'BUY',
          pos: this.symbols[symbol].pos,
          orderType: 'LMT',
          buyPrice: this.symbols[symbol].buyPrice,
          tif: 'DAY',
          transmit: false,
          symbol: symbol
        } as Order;
        const order = {
          orderId,
          action: 'BUY',
          totalQuantity: this.symbols[symbol].pos,
          orderType: 'LMT',
          lmtPrice: this.symbols[symbol].buyPrice,
          tif: 'DAY',
          transmit: false
        };
        this.ib.placeOrder(orderId, contract, order);
        this.symbols[symbol].orderId = orderId;
        //        this.currentOrder = this.orders[symbol];
      } catch (err) {
        console.error('❌ Buy Order Error:', err);
        this.symbols[symbol].tobuy = true;
      }
    }
  }

  private async placeSellOrder(symbol: string, sellPrice: number, quantity: number): Promise<void> {
    const contract = {
      symbol: symbol,
      secType: 'STK',
      currency: 'USD',
      exchange: 'SMART',
    };

    try {
      const orderId = this.nextOrderId++;
      this.symbols[symbol].sellPrice = sellPrice;
      const order = {
        orderId: orderId,
        action: 'SELL',
        totalQuantity: quantity,
        orderType: 'LMT',
        lmtPrice: sellPrice,
        tif: 'DAY',
        transmit: false,
      };

      // Save the order
      this.orders[symbol] = {
        orderId,
        action: 'SELL',
        pos: quantity,
        orderType: 'LMT',
        sellPrice,
        tif: 'DAY',
        transmit: false,
        symbol,
      } as Order;

      this.ib.placeOrder(orderId, contract, order);
      //      this.currentOrder = this.orders[symbol];
    } catch (err) {
      console.error('❌ Sell Order Error:', err);
    }
  }


  private getPositions1(): Promise<any[]> {
    return new Promise((resolve) => {
      const positions: any[] = [];

      this.ib.on('position', (account, contract, pos, avgCost) => {
        positions.push({ account, contract, pos, avgCost });
      });

      this.ib.once('positionEnd', () => {
        resolve(positions);
      });

      this.ib.reqPositions();
    });
  }

  private getOpenOrders(): Promise<any[]> {
    return new Promise((resolve) => {
      const orders: any[] = [];

      this.ib.on('openOrder', (orderId, contract: Contract, order: Order, orderState: OrderState) => {
        console.log('totototo');
        orders.push({ orderId, contract, order, orderState });
      });

      this.ib.once('openOrderEnd', () => {
        resolve(orders);
      });

      this.ib.reqOpenOrders(); // or ib.reqAllOpenOrders() depending on your need
    });
  }

}
