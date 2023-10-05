export const simpleEmailWithTemplate = ({
  header,
  body,
  btnUrl,
  btnLabel,
}: {
  header: string;
  body: string;
  btnUrl: string;
  btnLabel: string;
}) => {
  const brandColor = '#346df1';
  const color = {
    background: '#f9f9f9',
    text: '#444',
    mainBackground: '#fff',
    buttonBackground: brandColor,
    buttonBorder: brandColor,
    buttonText: '#fff',
    dangerButtonBackground: '#f44336',
  };

  return `
  <body style="background: ${color.background};">
    <table width="100%" border="0" cellspacing="0" cellpadding="0" style="max-width: 600px; margin: auto;">
      <tr><td height="20"></td></tr>
      <tr><td>
        <table width="100%" border="0" cellspacing="20" cellpadding="0" style="background: ${color.mainBackground}; border-radius: 10px;">
          <tr>
            <td align="center"
              style="padding: 10px 0px; font-size: 22px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
              ${header}
            </td>
          </tr>
          <tr>
            <td
              style="padding: 0px 0px 10px 0px; font-size: 16px; line-height: 22px; font-family: Helvetica, Arial, sans-serif; color: ${color.text};">
              ${body}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding: 0;">
              <table border="0" cellspacing="0" cellpadding="0">
                <tr>
                  <td align="center" style="border-radius: 5px;" bgcolor="${color.buttonBackground}"><a href="${btnUrl}"
                      target="_blank"
                      style="font-size: 18px; font-family: Helvetica, Arial, sans-serif; color: ${color.buttonText}; text-decoration: none; border-radius: 5px; padding: 10px 20px; border: 1px solid ${color.buttonBorder}; display: inline-block; font-weight: bold;">${btnLabel}</a></td>
                </tr>
              </table>
            </td>
          </tr> 
        </table>
      </td></tr>
      <tr><td height="20"></td></tr>
    </table>
  </body>
  `;
};
