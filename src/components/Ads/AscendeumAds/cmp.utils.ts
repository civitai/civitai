import { useEffect, useRef } from 'react';
import { create } from 'zustand';
import { useScript } from '~/hooks/useScript';

type TCData = {
  tcString: 'base64url-encoded TC string with segments';
  tcfPolicyVersion: 4;
  cmpId: 1000;
  cmpVersion: 1000;

  /**
   * true - GDPR Applies
   * false - GDPR Does not apply
   * undefined - unknown whether GDPR Applies
   * see the section: "What does the gdprApplies value mean?"
   */
  gdprApplies: boolean | undefined;

  /*
   * see addEventListener command
   */
  eventStatus: string;

  /**
   * see Ping Status Codes in following table
   */
  cmpStatus: string;

  /**
   * If this TCData is sent to the callback of addEventListener: number,
   * the unique ID assigned by the CMP to the listener function registered
   * via addEventListener.
   * Others: undefined.
   */
  listenerId: number | undefined;

  /*
   * true - Default value
   * false - TC String is invalid.
   * since Sept 1st 2021, TC strings established with global-scope are considered invalid.
   * see the section: ["What happened to Global Scope and Out of Band?"](https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/TCF-Implementation-Guidelines.md#gsoob) in "IAB Europe Transparency and Consent Framework Implementation Guidelines"
   */
  isServiceSpecific: boolean;

  /**
   * true - CMP is using publisher-customized stack descriptions and/or modified or supplemented standard Illustrations
   * false - CMP is NOT using publisher-customized stack descriptions and or modified or supplemented standard Illustrations
   */
  useNonStandardTexts: boolean;

  /**
   * Country code of the country that determines the legislation of
   * reference.  Normally corresponds to the country code of the country
   * in which the publisher's business entity is established.
   */
  publisherCC: string; // 'Two-letter ISO 3166-1 alpha-2 code';

  /**
   *
   * true - Purpose 1 not disclosed at all. CMPs use PublisherCC to
   * indicate the publisher's country of establishment to help Vendors
   * determine whether the vendor requires Purpose 1 consent.
   *
   * false - There is no special Purpose 1 treatment status. Purpose 1 was
   * disclosed normally (consent) as expected by TCF Policy
   */
  purposeOneTreatment: boolean;

  purpose: {
    consents: {
      /**
       * true - Consent
       * false | undefined - No Consent.
       */
      [purposeId: string]: boolean;
    };
    legitimateInterests: {
      /**
       * true - Legitimate Interest Established
       * false | undefined - No Legitimate Interest Established
       */
      [purposeId: string]: boolean;
    };
  };
  vendor: {
    consents: {
      /**
       * true - Consent
       * false | undefined - No Consent
       */
      [vendorId: string]: boolean;
    };
    legitimateInterests: {
      /**
       * true - Legitimate Interest Established
       * false | undefined - No Legitimate Interest Established
       */
      [vendorId: string]: boolean;
    };
  };
  specialFeatureOptins: {
    /**
     * true - Special Feature Opted Into
     * false | undefined - Special Feature NOT Opted Into
     */
    [specialFeatureId: string]: boolean;
  };
  publisher: {
    consents: {
      /**
       * true - Consent
       * false | undefined - No Consent
       */
      [purposeId: string]: boolean;
    };
    legitimateInterests: {
      /**
       * true - Legitimate Interest Established
       * false | undefined - No Legitimate Interest Established
       */
      [purposeId: string]: boolean;
    };
    customPurpose: {
      consents: {
        /**
         * true - Consent
         * false | undefined - No Consent
         */
        [purposeId: string]: boolean;
      };
      legitimateInterests: {
        /**
         * true - Legitimate Interest Established
         * false | undefined - No Legitimate Interest Established
         */
        [purposeId: string]: boolean;
      };
    };
    restrictions: {
      [purposeId: string]: {
        /**
         * 0 - Not Allowed
         * 1 - Require Consent
         * 2 - Require Legitimate Interest
         */
        [vendorId: string]: 0 | 1 | 2;
      };
    };
  };
};

declare global {
  interface Window {
    __tcfapi: any;
  }
}

export const useCmpDeclined = create(() => false);
export function useCmpListener() {
  useScript({
    content: `
  (function() {
    var host = 'civitai.com';
    var element = document.createElement('script');
    var firstScript = document.getElementsByTagName('script')[0];
    var url = 'https://cmp.inmobi.com'
      .concat('/choice/', '2MMzmDKaU6zew', '/', host, '/choice.js?tag_version=V3');
    var uspTries = 0;
    var uspTriesLimit = 3;
    element.async = true;
    element.type = 'text/javascript';
    element.src = url;

    firstScript.parentNode.insertBefore(element, firstScript);

    function makeStub() {
      var TCF_LOCATOR_NAME = '__tcfapiLocator';
      var queue = [];
      var win = window;
      var cmpFrame;

      function addFrame() {
        var doc = win.document;
        var otherCMP = !!(win.frames[TCF_LOCATOR_NAME]);

        if (!otherCMP) {
          if (doc.body) {
            var iframe = doc.createElement('iframe');

            iframe.style.cssText = 'display:none';
            iframe.name = TCF_LOCATOR_NAME;
            doc.body.appendChild(iframe);
          } else {
            setTimeout(addFrame, 5);
          }
        }
        return !otherCMP;
      }

      function tcfAPIHandler() {
        var gdprApplies;
        var args = arguments;

        if (!args.length) {
          return queue;
        } else if (args[0] === 'setGdprApplies') {
          if (
            args.length > 3 &&
            args[2] === 2 &&
            typeof args[3] === 'boolean'
          ) {
            gdprApplies = args[3];
            if (typeof args[2] === 'function') {
              args[2]('set', true);
            }
          }
        } else if (args[0] === 'ping') {
          var retr = {
            gdprApplies: gdprApplies,
            cmpLoaded: false,
            cmpStatus: 'stub'
          };

          if (typeof args[2] === 'function') {
            args[2](retr);
          }
        } else {
          if(args[0] === 'init' && typeof args[3] === 'object') {
            args[3] = Object.assign(args[3], { tag_version: 'V3' });
          }
          queue.push(args);
        }
      }

      function postMessageEventHandler(event) {
        var msgIsString = typeof event.data === 'string';
        var json = {};

        try {
          if (msgIsString) {
            json = JSON.parse(event.data);
          } else {
            json = event.data;
          }
        } catch (ignore) {}

        var payload = json.__tcfapiCall;

        if (payload) {
          window.__tcfapi(
            payload.command,
            payload.version,
            function(retValue, success) {
              var returnMsg = {
                __tcfapiReturn: {
                  returnValue: retValue,
                  success: success,
                  callId: payload.callId
                }
              };
              if (msgIsString) {
                returnMsg = JSON.stringify(returnMsg);
              }
              if (event && event.source && event.source.postMessage) {
                event.source.postMessage(returnMsg, '*');
              }
            },
            payload.parameter
          );
        }
      }

      while (win) {
        try {
          if (win.frames[TCF_LOCATOR_NAME]) {
            cmpFrame = win;
            break;
          }
        } catch (ignore) {}

        if (win === window.top) {
          break;
        }
        win = win.parent;
      }
      if (!cmpFrame) {
        addFrame();
        win.__tcfapi = tcfAPIHandler;
        win.addEventListener('message', postMessageEventHandler, false);
      }
    };

    makeStub();

    var uspStubFunction = function() {
      var arg = arguments;
      if (typeof window.__uspapi !== uspStubFunction) {
        setTimeout(function() {
          if (typeof window.__uspapi !== 'undefined') {
            window.__uspapi.apply(window.__uspapi, arg);
          }
        }, 500);
      }
    };

    var checkIfUspIsReady = function() {
      uspTries++;
      if (window.__uspapi === uspStubFunction && uspTries < uspTriesLimit) {
        console.warn('USP is not accessible');
      } else {
        clearInterval(uspInterval);
      }
    };

    if (typeof window.__uspapi === 'undefined') {
      window.__uspapi = uspStubFunction;
      var uspInterval = setInterval(checkIfUspIsReady, 6000);
    }
  })();
  `,
  });

  // https://github.com/InteractiveAdvertisingBureau/GDPR-Transparency-and-Consent-Framework/blob/master/TCFv2/IAB%20Tech%20Lab%20-%20CMP%20API%20v2.md#addeventlistener
  const listenerIdRef = useRef<number>();
  useEffect(() => {
    function cmpListener(tcdata: TCData, success: boolean) {
      listenerIdRef.current = tcdata.listenerId;
      if (success && tcdata.gdprApplies) {
        const values = Object.values(tcdata.purpose.consents);
        const declined = !values.length || values.some((value) => value !== true);
        useCmpDeclined.setState(declined);
      }
    }

    window.__tcfapi('addEventListener', 2, cmpListener);
    return () => {
      window.__tcfapi('removeEventListener', 2, cmpListener, listenerIdRef.current);
    };
  }, []);

  return useCmpDeclined();
}
