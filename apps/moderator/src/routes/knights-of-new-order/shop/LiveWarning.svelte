<script lang="ts">
  import { Alert, AlertDescription } from '@civitai/ui/components/ui/alert/index.js';
</script>

<Alert>
  <AlertDescription>
    Changes apply on the next request. Adding, retiring or restoring an item, or switching Rotating
    on any item, can redraw today's rotation and move today's deals. A moved deal or a changed
    price refuses purchases already in flight (<code>price-changed</code>).
  </AlertDescription>
</Alert>
