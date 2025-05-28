import { InovioPay } from '~/server/http/inoviopay/inoviopay.schema';

export const inoviopayApiResponseDescriptions: Record<number, string> = {
  100: 'Invalid login information (throttle)',
  101: 'Invalid login information',
  102: 'User not active',
  103: 'Invalid site',
  104: 'Invalid service',
  105: 'Invalid service action',
  106: 'Invalid service object',
  110: 'Required field',
  111: 'Invalid length',
  112: 'Not numeric',
  113: 'Invalid Data',
  115: 'Customer not found',
  116: 'User MUST change password',
  118: 'New password must not match the previous 5 passwords',
  119: 'request_ref_po_id and request_po_li_id mismatch',
  120: 'System Error',
  125: 'Duplicate Login',
  130: 'Same Product ID found on different line items.',
  135: 'Duplicate Company Name',
  136: 'Duplicate Site Name',
  150: 'Product Not Found',
  152: 'Product Type Not Found',
  153: 'Duplicate XTL product id',
  155: 'Selected currency not configured',
  160: 'Invalid product amount',
  165: 'Currency not supported',
  170: 'Duplicate product amount and currency',
  175: 'Language not supported',
  176: 'Duplicate product description and language',
  180: 'Invalid transaction limit type',
  181: 'Invalid limit type',
  183: 'Payment Type is required',
  205: 'No Permissions on requested object',
  210: 'Merchant Account not found',
  211: 'Currency not found',
  215: 'Invalid Card Brand',
  260: 'Invalid Process Ref ID',
  261: 'Invalid Process Type',
  410: 'Field not supported with wallet payment',
  411: 'REQUEST_CURRENCY mismatch with Cryptogram',
};

export const inoviopayServiceResponseDescriptions: Record<number, string> = {
  100: 'User Authorized',
  101: 'Service Available',
  150: 'Product Not Found',
  152: 'Product Type Not Found',
  155: 'Selected currency not configured',
  190: 'Invalid Product Configuration',
  192: 'Product Not Active',
  215: 'Activity limit exceeded',
  216: 'Invalid amount',
  217: 'No such issuer',
  218: 'Wrong PIN entered',
  219: 'R0: Stop recurring payments',
  220: 'R1: Stop recurring payments',
  221: 'System malfunction',
  500: 'No merchant account configured',
  501: 'Customer not found',
  502: 'Transaction error',
  503: 'Service Unavailable',
  505: 'Order adjusted to zero',
  506: 'Capture amount exceeds order value',
  507: 'Order fully captured',
  510: 'Order already reversed',
  511: 'Order already charged back',
  512: 'Order not found',
  515: 'Order fully credited',
  516: 'Credit amount exceeds order value',
  518: 'Missing required field',
  519: 'Missing Trial Descriptor',
  520: 'Unsupported Currency',
  522: 'Unsupported card brand',
  525: 'Batch Closed: Please credit',
  526: 'ApplePay is not supported on this merch_acct_id',
  528: 'ApplePay MCC Restricted',
  530: 'Downstream Processor Unavailable',
  536: 'Order not settled: Please reverse',
  540: 'Maximum Auth Limit Exceeded',
  555: 'Call Center',
  560: 'Invalid Service Action',
  565: 'Invalid Amount',
  570: 'Invalid Card Type',
  580: 'Unsupported Request',
  600: 'Declined',
  601: 'Scrub Decline',
  603: 'Fraud',
  605: 'Stolen Card',
  610: 'Pickup Card',
  615: 'Lost Card',
  620: 'Invalid CVV',
  621: 'Failed CVV',
  622: 'Invalid AVS',
  623: 'Failed AVS',
  624: 'Expired Card',
  625: 'Excessive Use',
  630: 'Invalid Card Number',
  635: 'Insufficient Funds',
  650: 'Retry',
  660: 'Do Not Honor',
  670: 'Partial Approval',
  675: 'Additional Authentication Required',
  680: 'Invalid Card Number, failed Mod 10 validation',
  685: 'Duplicate Transaction Detected',
  690: 'Duplicate Order Detected',
  692: 'Invalid Rebill Product',
  695: 'Site Username Unavailable',
  696: 'Membership Not Active',
  698: 'Membership Not Found',
  699: 'Membership Not Set for Rebill',
  700: 'Scrub Decline',
  720: 'Failed Age Validation',
  725: 'Invalid CPF',
};

// Map InovioPay.CreditCardTransactionInput keys to BuzzTransactionCreate keys
export const inovioPayToClientFieldMap: Record<string, string> = {
  CUST_FNAME: 'firstName',
  CUST_LNAME: 'lastName',
  CUST_EMAIL: 'email',
  BILL_ADDR: 'billingAddress',
  BILL_ADDR_CITY: 'billingCity',
  BILL_ADDR_STATE: 'billingState',
  BILL_ADDR_ZIP: 'billingZip',
  BILL_ADDR_COUNTRY: 'billingCountry',
  PMT_NUMB: 'cardNumber',
  TOKEN_GUID: 'tokenGuid',
  PMT_KEY: 'cardKey',
  PMT_EXPIRY: 'cardExpiry',
  LI_VALUE_1: 'unitAmount',
  XTL_ORDER_ID: 'xtlOrderId', // not in BuzzTransactionCreate, but for reference
  REQUEST_CURRENCY: 'currency',
  TRANS_REBILL_TYPE: 'rebillType', // not in BuzzTransactionCreate, but for reference
  CARD_ON_FILE_FLAG: 'cardOnFileFlag', // not in BuzzTransactionCreate, but for reference
};

export const createErrorFromInovioPayResponse = (
  response: Pick<
    InovioPay.CreditCardTransactionResponse,
    'API_RESPONSE' | 'SERVICE_RESPONSE' | 'REF_FIELD'
  >
): InovioPay.InovioPayError | null => {
  if (response.API_RESPONSE) {
    //  There was an error. Get some info out of it:
    const errorMessage =
      inoviopayApiResponseDescriptions[Number(response.API_RESPONSE)] ?? 'Unknown error';

    return new InovioPay.InovioPayError(
      `Inovopay API error: ${errorMessage}`,
      'API',
      Number(response.API_RESPONSE),
      response.REF_FIELD
        ? inovioPayToClientFieldMap[response.REF_FIELD.toUpperCase()] ?? ''
        : undefined
    );
  }

  if (response.SERVICE_RESPONSE) {
    // There was an error in the service response
    const errorMessage =
      inoviopayServiceResponseDescriptions[Number(response.SERVICE_RESPONSE)] ??
      'Unknown service error';

    return new InovioPay.InovioPayError(
      `Inovopay Service error: ${errorMessage}`,
      'API',
      Number(response.API_RESPONSE),
      response.REF_FIELD
        ? inovioPayToClientFieldMap[response.REF_FIELD.toUpperCase()] ?? ''
        : undefined
    );
  }

  return null;
};
