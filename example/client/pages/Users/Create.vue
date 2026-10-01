<script setup lang="ts">
import { Head, useForm } from '@inertiajs/vue3'
import Layout from '../../Layout.vue'

const form = useForm({ name: '' })
</script>

<template>
  <Head title="New user" />
  <Layout>
    <h1>New user</h1>
    <form @submit.prevent="form.post('/users')">
      <input v-model="form.name" placeholder="Name" />
      <button type="submit" :disabled="form.processing">Create</button>
      <p v-if="form.errors.name" style="color: crimson">{{ form.errors.name }}</p>
    </form>
  </Layout>
</template>
