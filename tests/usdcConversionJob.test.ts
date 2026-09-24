/**
 * Tests: AB-030 - USDC conversion must not record reserve history when the FX
 * conversion fails. A failed conversion that still writes reserveHistory rows
 * inflates recorded reserves and desyncs them from actual holdings.
 */

const mockReserveHistoryCreate = jest.fn().mockResolvedValue({});
const mockTransactionUpdate = jest.fn().mockResolvedValue({});
const mockConvertCurrency = jest.fn();
const mockGetProvider = jest.fn();
const mockGetCurrentBasket = jest.fn();

let consumeHandler: (msg: any) => Promise<void>;

const mockChannel = {
  prefetch: jest.fn(),
  consume: jest.fn((_queue: string, handler: any) => {
    consumeHandler = handler;
  }),
  ack: jest.fn(),
  nack: jest.fn(),
  sendToQueue: jest.fn(),
};

jest.mock("../src/config/logger", () => ({
  logger: {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.mock("../src/config/rabbitmq", () => ({
  connectRabbitMQ: jest.fn().mockResolvedValue(mockChannel),
  assertQueueWithDLQ: jest.fn().mockResolvedValue(undefined),
  QUEUES: {
    USDC_CONVERSION: "usdc_conversion",
    USDC_CONVERSION_DLQ: "usdc_conversion_dlq",
  },
}));

jest.mock("../src/config/database", () => ({
  prisma: {
    reserveHistory: { create: mockReserveHistoryCreate },
    transaction: { update: mockTransactionUpdate },
  },
}));

jest.mock("../src/services/basket", () => ({
  basketService: {
    getCurrentBasket: () => mockGetCurrentBasket(),
  },
}));

jest.mock("../src/services/fintech", () => ({
  getFintechRouter: () => ({ getProvider: mockGetProvider }),
}));

jest.mock("../src/jobs/queueConfig", () => ({
  getQueueMaxRetries: () => 3,
}));

import { startUsdcConversionConsumer } from "../src/jobs/usdcConversionJob";

function makeMsg(payload: unknown): any {
  return {
    content: Buffer.from(JSON.stringify(payload)),
    properties: { headers: {} },
  };
}

describe("usdcConversionJob (AB-030)", () => {
  beforeEach(async () => {
    jest.clearAllMocks();
    mockGetCurrentBasket.mockResolvedValue([
      { currency: "NGN", weight: 50 },
      { currency: "KES", weight: 50 },
    ]);
    await startUsdcConversionConsumer();
  });

  it("records reserve history only for successful FX conversions", async () => {
    mockGetProvider.mockImplementation(async (currency: string) => {
      if (currency === "NGN") {
        return { convertCurrency: jest.fn().mockRejectedValue(new Error("FX down")) };
      }
      return { convertCurrency: jest.fn().mockResolvedValue({}) };
    });

    await consumeHandler(
      makeMsg({ usdcAmount: "100", recipient: "GABC", txHash: "tx1" }),
    );

    // NGN conversion failed -> no reserveHistory row for NGN.
    // KES conversion succeeded -> exactly one row, for KES.
    expect(mockReserveHistoryCreate).toHaveBeenCalledTimes(1);
    expect(mockReserveHistoryCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ currency: "KES", reason: "conversion" }),
      }),
    );
    expect(mockChannel.ack).toHaveBeenCalledTimes(1);
  });

  it("records reserve history for every currency when all conversions succeed", async () => {
    mockGetProvider.mockResolvedValue({
      convertCurrency: jest.fn().mockResolvedValue({}),
    });

    await consumeHandler(
      makeMsg({ usdcAmount: "100", recipient: "GABC", txHash: "tx2" }),
    );

    expect(mockReserveHistoryCreate).toHaveBeenCalledTimes(2);
    const currencies = mockReserveHistoryCreate.mock.calls.map(
      (c) => c[0].data.currency,
    );
    expect(currencies.sort()).toEqual(["KES", "NGN"]);
  });
});
